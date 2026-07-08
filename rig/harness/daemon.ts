// 검증 리그 — 헤드리스 데몬 하니스 (설계 §4 / G1)
//
// `dist/daemon-bundle/index.js`를 격리 env(RigContext)로 스폰하고, `daemon.ping`
// 폴링으로 ready를 확인한다. 앱 없이 데몬 파이프 전 표면(채널·A2A·principal)을
// 노출하므로 SIM 레인은 이 하니스만으로 성립한다(G1).
//
// 번들 부재 시 자동 빌드하지 않고 명시 에러(설계 §9 정찰 3, footgun: 테스트에서 수 분
// 빌드는 함정). node-pty는 번들이 external로 두므로, node_modules 해석이 가능한
// 리포 루트를 cwd로 스폰한다(정찰 4).
//
// 재스폰(respawn)은 S7(SIGKILL→replay 수렴) 대비 API로만 제공 — 같은 suffix로 다시
// 스폰하면 데몬이 디스크(임시 홈 안)에서 상태를 복원한다. v1 S1은 소비하지 않는다.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import type { RigContext } from './isolation';

/** 리포 루트 기준 데몬 번들 상대경로(package.json build:daemon 산출물). */
const DAEMON_BUNDLE_REL = path.join('dist', 'daemon-bundle', 'index.js');

/** 리포 루트를 찾는다. 이 파일은 `{root}/rig/harness/daemon.ts`이므로 두 단계 위. */
function repoRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

export interface RigDaemonOptions {
  /** ready 폴링 총 예산(ms). 기본 20초(도그푸드 waitReady 관례). */
  readonly readyTimeoutMs?: number;
  /** ready 폴링 간격(ms). 기본 300ms. */
  readonly pollIntervalMs?: number;
}

/**
 * 격리된 헤드리스 wmux 데몬 프로세스 1기를 소유한다. 스폰·ready 대기·SIGKILL·재스폰·
 * 로그 채집·teardown을 제공. 파이프 RPC는 PipeClient가 별도로 담당(관심사 분리).
 */
export class RigDaemon {
  private readonly ctx: RigContext;
  private readonly bundlePath: string;
  private readonly readyTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private proc: ChildProcess | null = null;
  /** stdout+stderr 채집 버퍼(실패 시 진단 인쇄용). */
  private readonly logChunks: string[] = [];

  constructor(ctx: RigContext, opts: RigDaemonOptions = {}) {
    this.ctx = ctx;
    this.bundlePath = path.join(repoRoot(), DAEMON_BUNDLE_REL);
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 20000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 300;
  }

  /** 채집된 데몬 로그 전문(실패 시 테스트가 인쇄). */
  get log(): string {
    return this.logChunks.join('');
  }

  /** 현재 스폰된 프로세스의 pid(없으면 undefined). */
  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /**
   * 데몬 번들을 스폰하고 `daemon.ping`이 ok를 반환할 때까지 폴링한다. 번들이 없으면
   * 자동 빌드 대신 명시 에러(먼저 `npm run build:daemon`). 조기 종료(exit)는 즉시
   * 실패로 이어지도록 exit 리스너로 ready 폴링을 깨운다.
   */
  async start(): Promise<void> {
    if (this.proc) throw new Error('[rig/daemon] already started');
    if (!fs.existsSync(this.bundlePath)) {
      throw new Error(
        `[rig/daemon] daemon bundle not found at ${this.bundlePath} — ` +
          'run `npm run build:daemon` first (rig does NOT auto-build; a multi-minute ' +
          'build inside a test is a footgun — 설계 §9 정찰 3).',
      );
    }
    await this.spawnAndWait();
  }

  /**
   * 프로세스 트리를 SIGKILL로 죽인다(부분집합 replay 실증 S7의 카오스 주입). 커밋
   * 배리어와 무관하게 즉발 종료를 강제한다. exit를 기다리지 않는다 — 호출자가 필요하면
   * respawn()이 새 프로세스를 기다린다.
   */
  kill(): void {
    if (!this.proc) return;
    try {
      this.proc.kill('SIGKILL');
    } catch {
      // 이미 죽었을 수 있음.
    }
    this.proc = null;
  }

  /**
   * SIGKILL 후 같은 suffix로 데몬을 다시 스폰하고 ready를 기다린다(S7 replay 수렴 API).
   * 디스크 상태(임시 홈 안 이벤트 로그·config)가 그대로라 복원된다. 살아있는 프로세스가
   * 있으면 먼저 kill.
   */
  async respawn(): Promise<void> {
    if (this.proc) this.kill();
    await this.spawnAndWait();
  }

  /**
   * teardown: 프로세스 트리 kill. 임시 홈 삭제는 호출자(테스트)가 removeRigHome로
   * 별도 수행한다 — 순서는 kill → removeRigHome(§2). 데몬 핸들을 소유한 쪽이 kill을
   * 책임지므로 여기서 프로세스만 정리한다.
   */
  teardown(): void {
    this.kill();
  }

  /** 스폰 + ready 폴링 공통 경로(start/respawn 공유). */
  private async spawnAndWait(): Promise<void> {
    const proc = spawn(process.execPath, [this.bundlePath], {
      cwd: repoRoot(), // node-pty native 해석을 위해 node_modules가 있는 루트(정찰 4)
      env: this.ctx.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;

    const collect = (d: Buffer): void => {
      this.logChunks.push(d.toString());
    };
    proc.stdout?.on('data', collect);
    proc.stderr?.on('data', collect);

    // 조기 종료를 감지하는 플래그 — ready 폴링이 무한 대기하지 않도록.
    let exited = false;
    let exitInfo = '';
    proc.once('exit', (code, signal) => {
      exited = true;
      exitInfo = `code=${code} signal=${signal}`;
      // 이 핸들이 우리가 추적 중인 프로세스일 때만 참조를 끊는다(respawn 경합 방지).
      if (this.proc === proc) this.proc = null;
    });

    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (exited) {
        throw new Error(
          `[rig/daemon] daemon exited before becoming ready (${exitInfo}).\n` +
            `--- daemon log ---\n${this.log}`,
        );
      }
      if (await this.pingOnce()) return;
      await sleep(this.pollIntervalMs);
    }
    // 타임아웃 — 진단을 위해 로그를 실어 던진다.
    this.kill();
    throw new Error(
      `[rig/daemon] daemon did not become ready within ${this.readyTimeoutMs}ms.\n` +
        `--- daemon log ---\n${this.log}`,
    );
  }

  /**
   * `daemon.ping` 1회. ready 판정 전용의 가벼운 소켓 왕복이라 PipeClient(신원 바인딩)
   * 대신 여기 인라인한다 — ping은 신원 무관 호출이고, ready 전에는 토큰 파일이 아직
   * 없을 수도 있어 실패를 조용히 false로 흡수해야 한다.
   */
  private pingOnce(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let token = '';
      try {
        token = fs.readFileSync(this.ctx.daemonTokenPath, 'utf8').trim();
      } catch {
        // 토큰 파일이 아직 없음 — 데몬이 부팅 중. 재시도.
        resolve(false);
        return;
      }
      const id = `ping-${Date.now()}-${Math.random()}`;
      const sock = net.createConnection(this.ctx.daemonPipePath);
      let buf = '';
      let done = false;
      const finish = (ok: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          sock.destroy();
        } catch {
          /* noop */
        }
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), 2000);
      sock.setEncoding('utf8');
      sock.once('connect', () => sock.write(JSON.stringify({ id, method: 'daemon.ping', params: {}, token }) + '\n'));
      sock.once('error', () => finish(false));
      sock.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg: { id?: string; ok?: boolean };
          try {
            msg = JSON.parse(line) as { id?: string; ok?: boolean };
          } catch {
            continue;
          }
          if (msg.id !== id) continue;
          finish(msg.ok === true);
          return;
        }
      });
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
