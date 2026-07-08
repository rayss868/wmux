// 검증 리그 — 데몬 파이프 클라이언트 (설계 §5 / G6)
//
// 데몬 제어 파이프에 line-delimited JSON-RPC로 연결한다. 프로토콜은 서버 정본
// `src/daemon/DaemonPipeServer.ts`를 정독해 정제:
//   - 프레이밍: 요청·응답 모두 `\n`으로 구분된 JSON 한 줄(:398 split('\n'),
//     :478 write(JSON+'\n')). 응답은 `id`로 상관(broadcast 이벤트 줄이 끼어들 수 있어
//     매칭되지 않는 id·이벤트 줄은 무시 — 도그푸드 rpcCall 관례).
//   - 인증: 모든 요청에 `token` 필드(:438-447 timingSafeEqual). 불일치면 소켓 파괴.
//     토큰은 `{홈}/.wmux{suffix}/daemon-auth-token`에서 연결 시 읽는다(데몬이 부팅 시 민팅).
//   - 이중 ok 계층(도그푸드 a2a-symmetric-reply-dogfood.mjs:92-109이 명시한 함정):
//     · 트랜스포트 봉투 `{id, ok, result}` — 핸들러가 throw 안 하면 항상 ok:true.
//     · 핸들러 페이로드 `result` — 채널 op는 `result.ok`(ChannelService Result<T>
//       판별 유니온)가 실제 성공/실패. `call()`은 result를 벗겨 돌려주고,
//       `channelRpc()`가 `result.ok===false`를 ChannelError로 throw한다.
//
// 지속 연결(persistent socket): 호출당 새 소켓을 여는 도그푸드 방식은 데몬의 연결률 캡
// (`MAX_NEW_CONNECTIONS_PER_SEC = 20`, DaemonPipeServer:57)에 걸려 flood 부하에서
// EPIPE 폭주를 일으킨다(스모크 실증: 80연사 중 32건 탈락). 그래서 PipeClient는 소켓
// 1개를 롱리브드로 유지하고 RPC를 id로 멀티플렉싱한다 — 연결 churn을 없애고 데몬의
// per-socket 캡(50/sec)만 상대한다(페르소나당 소켓 1개라 8ws=400/sec 여유). 연결이
// 끊기면 다음 호출에서 지연 재연결한다.
//
// G6 정직-main 규율: 생성자에 workspaceId 1개를 바인딩하고 모든 채널 호출에 그 값만
// `verifiedWorkspaceId`로 스탬프한다. 예약 신원(ws-human/local-ui)·타 ws 자칭은
// 하네스 레벨에서 throw — 제품에 테스트 전용 경로 0. 데몬은 pre-stamped
// verifiedWorkspaceId를 verbatim 신뢰하므로(`channelCallerIdentity.ts:92-94` Rule 1)
// SIM은 "정직한 main"을 모사할 뿐이고, 커버 못 하는 라우터 게이트는 §2.5 커버리지 맵에
// 정직 선언돼 있다(리그 사각).

import net from 'node:net';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

/** 트랜스포트 봉투 — 데몬 파이프가 모든 응답에 씌운다. */
interface RpcEnvelope {
  id: string;
  ok: boolean;
  /** ok:true일 때의 핸들러 반환값. 채널 op면 자체 { ok, ... } Result를 담는다. */
  result?: unknown;
  /** ok:false일 때의 트랜스포트 레벨 에러 문자열(미인증·알 수 없는 메서드 등). */
  error?: string;
}

/** id로 상관되는 미결 RPC 하나. */
interface Pending {
  resolve: (env: RpcEnvelope) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

/** 데몬 파이프에 스탬프 없이 예약된 신원 — 하네스가 페르소나 자칭을 금지한다(G6). */
const RESERVED_WORKSPACE_IDS = new Set(['ws-human', 'local-ui']);

export interface PipeClientOptions {
  /** RPC 응답 대기 타임아웃(ms). 기본 8초(도그푸드 관례). */
  readonly timeoutMs?: number;
}

/**
 * 데몬 파이프 RPC 클라이언트. 소켓 1개를 지속 유지하고 RPC를 id로 멀티플렉싱한다.
 *
 * 정직-main 규율(G6): 이 클라이언트는 정확히 하나의 workspaceId를 대변한다. 채널
 * 뮤테이션/조회 헬퍼는 그 값을 verifiedWorkspaceId로 스탬프하고, 페르소나가 다른 ws나
 * 예약 신원을 자칭하려 하면 즉시 throw한다(제품 코드 우회 아님 — 하네스 계약).
 */
export class PipeClient {
  private readonly pipePath: string;
  private readonly tokenPath: string;
  private readonly workspaceId: string;
  private readonly timeoutMs: number;

  private sock: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private buf = '';
  private readonly pending = new Map<string, Pending>();
  private closed = false;

  /**
   * @param pipePath      데몬 제어 파이프 주소(RigContext.daemonPipePath).
   * @param tokenPath     데몬 auth token 파일 경로(RigContext.daemonTokenPath).
   * @param workspaceId   이 클라이언트가 대변하는 페르소나 workspaceId(G6 바인딩).
   *                      예약 신원(ws-human/local-ui)이면 생성 자체를 거부한다.
   */
  constructor(pipePath: string, tokenPath: string, workspaceId: string, opts: PipeClientOptions = {}) {
    if (RESERVED_WORKSPACE_IDS.has(workspaceId)) {
      throw new Error(
        `[rig/pipe] refusing to bind PipeClient to reserved identity "${workspaceId}" ` +
          '(G6: 페르소나는 정직-main 모사; 예약 신원 자칭 금지)',
      );
    }
    if (!workspaceId || !workspaceId.trim()) {
      throw new Error('[rig/pipe] PipeClient requires a non-empty workspaceId (G6 정직-main 바인딩)');
    }
    this.pipePath = pipePath;
    this.tokenPath = tokenPath;
    this.workspaceId = workspaceId;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  /** 이 클라이언트가 바인딩된 workspaceId(읽기 전용 노출 — 어서션 상관용). */
  get ws(): string {
    return this.workspaceId;
  }

  /** 소켓을 닫고 미결 RPC를 전부 reject한다(teardown 시 호출 권장). */
  close(): void {
    this.closed = true;
    const s = this.sock;
    this.sock = null;
    if (s) {
      try {
        s.destroy();
      } catch {
        /* noop */
      }
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('[rig/pipe] client closed'));
    }
    this.pending.clear();
  }

  private readToken(): string {
    try {
      return fs.readFileSync(this.tokenPath, 'utf8').trim();
    } catch {
      return '';
    }
  }

  /**
   * 지속 소켓을 확보한다(없으면 연결). 연결 중이면 같은 Promise를 공유한다. 연결이
   * 끊기면 미결 RPC를 reject하고 소켓을 비워 다음 호출이 재연결하게 한다.
   */
  private ensureSocket(): Promise<net.Socket> {
    if (this.closed) return Promise.reject(new Error('[rig/pipe] client closed'));
    if (this.sock && !this.sock.destroyed) return Promise.resolve(this.sock);
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<net.Socket>((resolve, reject) => {
      const sock = net.createConnection(this.pipePath);
      sock.setEncoding('utf8');
      const onConnectErr = (e: Error): void => {
        this.connecting = null;
        reject(e);
      };
      sock.once('error', onConnectErr);
      sock.once('connect', () => {
        sock.removeListener('error', onConnectErr);
        this.sock = sock;
        this.connecting = null;
        this.attach(sock);
        resolve(sock);
      });
    });
    return this.connecting;
  }

  /** 소켓에 data/close 핸들러를 붙인다(응답 프레이밍 + 연결 종료 정리). */
  private attach(sock: net.Socket): void {
    sock.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let msg: RpcEnvelope;
        try {
          msg = JSON.parse(line) as RpcEnvelope;
        } catch {
          continue;
        }
        // broadcast 이벤트 줄(id 없음)이나 매칭 안 되는 id는 무시.
        if (typeof msg.id !== 'string') continue;
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    });
    const onGone = (): void => {
      if (this.sock === sock) this.sock = null;
      this.buf = '';
      // 이 소켓에 매인 미결 RPC를 전부 reject → 호출자가 재시도/실패 판단.
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new Error(`[rig/pipe] connection lost before ${p.method} responded`));
      }
    };
    sock.once('close', onGone);
    sock.once('error', onGone);
  }

  /**
   * 원시 RPC. 트랜스포트 봉투를 벗겨 `result`를 돌려준다(핸들러 페이로드). 트랜스포트
   * 레벨 실패(미인증·알 수 없는 메서드·envelope.ok===false)는 throw. 채널 Result의
   * `result.ok===false`는 여기서 판단하지 않는다 — `channelRpc()`가 담당.
   *
   * @param stamp verifiedWorkspaceId 자동 스탬프 여부. 채널/principal 뮤테이션은 true,
   *              daemon.ping 같은 신원 무관 호출은 false.
   */
  async call(method: string, params: Record<string, unknown> = {}, stamp = false): Promise<unknown> {
    const finalParams: Record<string, unknown> = { ...params };
    if (stamp) {
      const claimed = finalParams['verifiedWorkspaceId'];
      // 페르소나가 명시적으로 타 ws를 자칭하면 거부(G6). 미지정이면 바인딩 값으로 채운다.
      if (typeof claimed === 'string' && claimed.length > 0 && claimed !== this.workspaceId) {
        throw new Error(
          `[rig/pipe] persona bound to "${this.workspaceId}" attempted to stamp foreign ` +
            `verifiedWorkspaceId "${claimed}" (G6 위반)`,
        );
      }
      finalParams['verifiedWorkspaceId'] = this.workspaceId;
    }

    const envelope = await this.transact(method, finalParams);
    if (!envelope.ok) {
      throw new Error(`[rig/pipe] transport failure on ${method}: ${envelope.error ?? 'unknown'}`);
    }
    return envelope.result;
  }

  /**
   * 채널 RPC. `call(..., stamp=true)`로 verifiedWorkspaceId를 스탬프한 뒤, 핸들러
   * 페이로드의 판별 유니온을 검사한다: `result.ok===false`면 ChannelError로 throw(테스트가
   * 실패 원인을 즉시 본다), ok:true면 페이로드 전체를 돌려준다.
   */
  async channelRpc(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const result = await this.call(method, params, true);
    if (result === null || typeof result !== 'object') {
      throw new Error(`[rig/pipe] ${method} returned non-object payload: ${JSON.stringify(result)}`);
    }
    const payload = result as Record<string, unknown>;
    if (payload['ok'] === false) {
      const err = payload['error'];
      const detail =
        err && typeof err === 'object' ? JSON.stringify(err) : String(err ?? 'unknown channel error');
      throw new Error(`[rig/pipe] ${method} rejected: ${detail}`);
    }
    return payload;
  }

  /** 지속 소켓 위로 RPC 1건을 보내고 id 매칭 응답을 기다린다. */
  private async transact(method: string, params: Record<string, unknown>): Promise<RpcEnvelope> {
    const sock = await this.ensureSocket();
    const token = this.readToken();
    const id = randomUUID();
    return new Promise<RpcEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[rig/pipe] rpc timeout (${this.timeoutMs}ms): ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        sock.write(JSON.stringify({ id, method, params, token }) + '\n');
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  }
}
