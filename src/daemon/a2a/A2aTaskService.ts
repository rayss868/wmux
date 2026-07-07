/**
 * A2aTaskService — A2A 태스크의 **데몬측 정본**(envelope-design §5 D11).
 *
 * 종전 A2A 정본은 렌더러 인메모리 스토어(a2aSlice)였다 — 30분 GC 비내구라 채널과
 * 비대칭이었다. 본 서비스가 정본을 데몬 append-only 로그로 이동한다:
 *   - projection-first: 태스크 맵 projection을 들고, 모든 전이를 `domain:'a2a'`
 *     envelope로 **먼저 커밋(append→true)한 뒤 projection에 적용**한다. append가
 *     false(배치 롤백)면 projection은 건드리지 않는다 — 로그가 정본이므로.
 *   - `VALID_TRANSITIONS`(types.ts) 데몬측 강제(성공 종단='completed').
 *   - 완료증거(evidence)는 §6.M PR-D′ 스키마를 **수용만** 한다:
 *     normalizeCompletionEvidenceWire로 재검증(sanitize) 후 verbatim 저장.
 *     **게이트·거부(verified≥1)는 넣지 않는다** — Q1-4b/PR-B 소관.
 *   - per-task 직렬화(뮤텍스)로 collect→append→apply 일관성.
 *   - clientMsgId류 멱등(§4): (taskId, idempotencyKey) LRU — 재시도는 append 없이
 *     원본 결과 반환(동일 키 재시도 → 로그 1건).
 *   - 30분 GC 시멘틱은 projection 레벨 유지(a2aSlice 현행 준수, 로그 절단 아님).
 *
 * authContext 스탬핑의 정본화(서버핀 principalId/trustTier)는 envelope PR5 소관 —
 * 여기서는 호출자가 넘긴 verifiedWorkspaceId를 담고 나머지는 보수적 기본값을 쓴다.
 */

import { makeEnvelope } from '../../shared/eventlog';
import type {
  AuthContext,
  EventEnvelope,
  EventEnvelopeDraft,
  TrustTier,
} from '../../shared/eventlog';
import type {
  Artifact,
  CompletionEvidence,
  Message,
  Task,
  TaskState,
  WmuxTaskMetadata,
} from '../../shared/types';
import { validateTransition, VALID_TRANSITIONS, TERMINAL_STATES } from '../../shared/types';
import {
  isVerifiedItem,
  normalizeCompletionEvidenceWire,
} from '../../shared/completionEvidence';
import type {
  A2aTaskCancelPayload,
  A2aTaskCreatePayload,
  A2aTaskTransitionPayload,
} from '../../shared/a2aEventlog';

/** a2aSlice 현행 값 준수(캐시와 동일 시멘틱). */
const GC_MAX_AGE_MS = 30 * 60 * 1000; // 30분
const GC_MAX_TASKS = 500;
/** §4: 멱등 LRU cap/stream — 채널 상수(CHANNEL_IDEMPOTENCY_CAP=1000)와 동형. */
const IDEMPOTENCY_CAP = 1000;

/** append + readAllRecords만 요구하는 최소 로그 인터페이스(AppendOnlyLog 만족). */
export interface A2aLogLike {
  append(draft: EventEnvelopeDraft): Promise<boolean>;
  readAllRecords(): EventEnvelope[];
}

export interface A2aTaskServiceOptions {
  log: A2aLogLike;
  /** envelope origin(§8). machineId·daemonEpoch는 부트에서 확정. */
  origin: { machineId: string; daemonEpoch: number };
  /** GC/타임스탬프 주입(테스트). 기본 Date.now. */
  now?: () => number;
}

/** 한 페인 좌표(선택적 pane-granular authz). */
export interface PaneAddr {
  paneId?: string;
  surfaceId?: string;
}

export interface CreateTaskInput {
  id?: string;
  title: string;
  from: { workspaceId: string; name: string; paneId?: string; surfaceId?: string };
  to: { workspaceId: string; name: string; paneId?: string; surfaceId?: string; ptyId?: string };
  history?: Message[];
  artifacts?: Artifact[];
}

export interface TransitionInput {
  taskId: string;
  to: TaskState;
  /** 서버핀된 호출자 workspace(수신자여야 함). */
  callerWorkspaceId: string;
  /** 알려진 경우의 호출자 페인(pane-granular authz). 헤드리스면 null/undefined. */
  callerAddr?: PaneAddr | null;
  /**
   * 호출자가 페인 신원(senderPtyId)을 주장했는가. S-C2 pane-granular authz는
   * 렌더러 페인 트리에서만 판정 가능하다(ptyId→pane 해석은 렌더러 소유) — 페인
   * 핀 태스크(to.paneId)에 페인 신원 호출자가 오면 데몬은 soft-defer하고 main이
   * 렌더러 검증 경로로 폴백한다(오늘의 판정 지점 보존, 서버측 이관은 PR5/§7).
   */
  callerHasPaneIdentity?: boolean;
  /** 사람용 상태 메시지(있을 때만). */
  message?: Message;
  /** §6.M 완료증거(raw). 서비스가 재정규화(sanitize)해 저장 — 게이트 없음. */
  evidence?: unknown;
  /** §4 멱등키(clientMsgId류). 재시도 흡수. */
  idempotencyKey?: string;
  /** authContext 보강(PR5 전 임시): principalId/trustTier 오버라이드. */
  principalId?: string;
  trustTier?: TrustTier;
}

export interface CancelTaskInput {
  taskId: string;
  callerWorkspaceId: string;
  idempotencyKey?: string;
  principalId?: string;
  trustTier?: TrustTier;
}

export type OpErr = { ok: false; error: string };
/**
 * 전이/취소/생성 성공 결과는 커밋된 태스크 스냅샷을 동반한다 — 렌더러 캐시가 이 값을
 * **재검증 없이 verbatim 적용**한다(§6.M C6, a2aSlice.applyDaemonTaskUpdate).
 */
export type TransitionOk = { ok: true; verifiedItemCount?: number; task: Task };
export type CancelOk = { ok: true; task: Task };
export type CreateOk = { ok: true; taskId: string; task: Task };

export interface QueryFilters {
  status?: TaskState;
  role?: 'user' | 'agent';
  updatedSince?: string;
}

export class A2aTaskService {
  private readonly log: A2aLogLike;
  private readonly origin: { machineId: string; daemonEpoch: number };
  private readonly now: () => number;

  /** projection: taskId → Task(정본 상태의 인메모리 뷰, 로그에서 재파생 가능). */
  private readonly tasks = new Map<string, Task>();
  /** per-task 직렬화 체인(collect→append→apply 일관성). */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** §4 멱등: streamId(taskId) → (idempotencyKey → 원본 결과). LRU cap. */
  private readonly idempotency = new Map<string, Map<string, TransitionOk | CancelOk>>();

  constructor(opts: A2aTaskServiceOptions) {
    this.log = opts.log;
    this.origin = opts.origin;
    this.now = opts.now ?? Date.now;
  }

  // ── 부트 복원 (cross-restart projection) ────────────────────────────

  /**
   * 로그의 `domain:'a2a'` 레코드를 순서대로 replay해 projection 복원.
   * 비내구→내구 전환의 핵심 가치: 재시작 후 태스크가 살아남는다. 부트 1회 호출.
   */
  restoreFromLog(): void {
    for (const rec of this.log.readAllRecords()) {
      if (rec.domain !== 'a2a') continue;
      this.applyPayload(rec.payload);
      this.restoreIdempotency(rec); // E: 크로스-재시작 멱등 재시드
    }
    // A: 부트 직후 GC — 30분 경과 종단 태스크를 즉시 정리한다. 로그는 영구이므로
    // 이게 없으면 restore가 역대 전 종단 태스크를 매 부트 부활시켜(projection 무한
    // 성장) query에 노출한다. GC는 projection만 바운드(로그 절단은 §9 컴팩션 몫).
    this.gcTerminalTasks();
  }

  /**
   * E(패널): 재시작 후 같은 idempotencyKey 재시도가 원본 결과를 반환하도록 멱등 LRU를
   * replay에서 재구성한다. 없으면 재시도가 캐시 미스→invalid transition(태스크가 이미
   * 전진)으로 변질된다. transition/cancel만 키를 싣는다(create는 결정적 id로 멱등).
   */
  private restoreIdempotency(rec: EventEnvelope): void {
    if (!rec.idempotencyKey) return;
    const p = rec.payload as { kind?: unknown; taskId?: unknown; verifiedItemCount?: unknown };
    if (p.kind !== 'task.transition' && p.kind !== 'task.cancel') return;
    if (typeof p.taskId !== 'string') return;
    const task = this.tasks.get(p.taskId);
    if (!task) return;
    const result: TransitionOk | CancelOk =
      p.kind === 'task.transition'
        ? {
            ok: true,
            task,
            ...(typeof p.verifiedItemCount === 'number' ? { verifiedItemCount: p.verifiedItemCount } : {}),
          }
        : { ok: true, task };
    this.idempotencyRecord(p.taskId, rec.idempotencyKey, result);
  }

  /**
   * payload를 projection에 적용(append 성공 후에만 호출). kind가 닫힌 union이라
   * 미지 kind(executor-lifecycle 예약 슬롯 등)는 안전하게 무시한다(fail-closed).
   */
  private applyPayload(payload: unknown): void {
    if (payload === null || typeof payload !== 'object') return;
    const p = payload as { kind?: unknown };
    if (p.kind === 'task.create') {
      const { task } = payload as A2aTaskCreatePayload;
      if (task && typeof task.id === 'string' && !this.tasks.has(task.id)) {
        this.tasks.set(task.id, task);
      }
      return;
    }
    if (p.kind === 'task.transition') {
      const t = payload as A2aTaskTransitionPayload;
      const task = this.tasks.get(t.taskId);
      if (!task) return;
      task.status = {
        state: t.to,
        timestamp: t.timestamp,
        ...(t.message ? { message: t.message } : {}),
        ...(t.evidence ? { evidence: t.evidence } : {}),
      };
      task.metadata.updatedAt = t.timestamp;
      return;
    }
    if (p.kind === 'task.cancel') {
      const c = payload as A2aTaskCancelPayload;
      const task = this.tasks.get(c.taskId);
      if (!task) return;
      task.status = { state: 'canceled', timestamp: c.timestamp };
      task.metadata.updatedAt = c.timestamp;
      return;
    }
    // executor-lifecycle / 미지 kind: 예약 슬롯 — projection 무시.
  }

  // ── mutation ───────────────────────────────────────────────────────

  /**
   * 태스크 생성 → `task.create` envelope append → projection 시드.
   * 멱등(A3): 동일 id가 이미 있으면 append 없이 기존 유지(완료 태스크 부활 방지).
   */
  createTask(input: CreateTaskInput): Promise<CreateOk | OpErr> {
    const id = input.id ?? this.generateTaskId();
    return this.withTaskLock(id, async () => {
      // A3 멱등: 결정적 id(chmention-*) 재배달은 기존 상태를 보존.
      const existing = this.tasks.get(id);
      if (existing) return { ok: true, taskId: id, task: existing };

      const nowIso = this.isoNow();
      const metadata: WmuxTaskMetadata = {
        title: input.title,
        from: input.from,
        to: input.to,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      const task: Task = {
        kind: 'task',
        id,
        status: { state: 'submitted', timestamp: nowIso },
        history: input.history ?? [],
        artifacts: input.artifacts ?? [],
        metadata,
      };
      const payload: A2aTaskCreatePayload = { kind: 'task.create', task };
      const committed = await this.log.append(
        this.envelope(payload, input.from.workspaceId),
      );
      if (!committed) {
        return { ok: false, error: 'a2a.task.create: daemon log append failed (uncommitted)' };
      }
      this.applyPayload(payload);
      return { ok: true, taskId: id, task };
    });
  }

  /**
   * 상태 전이 — 데몬 정본 게이트. 권한 + VALID_TRANSITIONS 강제, evidence는 수용만.
   * append(true) 후에만 projection 적용. 멱등키가 있으면 재시도 흡수(로그 1건).
   */
  transition(input: TransitionInput): Promise<TransitionOk | OpErr> {
    return this.withTaskLock(input.taskId, async () => {
      // §4 멱등: 앞서 커밋된 동일 키면 append 없이 원본 결과.
      const cached = this.idempotencyHit(input.taskId, input.idempotencyKey);
      if (cached) return cached as TransitionOk;

      const task = this.tasks.get(input.taskId);
      if (!task) return { ok: false, error: `a2a.task.update: task not found: ${input.taskId}` };

      // 권한: 수신자 workspace만 상태 갱신 가능(a2aSlice 현행 계약).
      if (task.metadata.to.workspaceId !== input.callerWorkspaceId) {
        return { ok: false, error: `a2a.task.update: caller ${input.callerWorkspaceId} is not the receiver` };
      }
      // pane-granular authz(S-C2): 호출자 페인이 알려졌고(callerAddr) 태스크가 특정
      // 수신 페인에 핀됐으면(to.paneId) 그 페인이어야 한다. callerAddr 부재(헤드리스
      // ClaudeWorker)면 ws-authz — 이 불변식이 워커 완료 전이를 막지 않게 한다.
      if (input.callerAddr && task.metadata.to.paneId && task.metadata.to.paneId !== input.callerAddr.paneId) {
        return { ok: false, error: 'a2a.task.update: caller pane is not the addressed receiver pane' };
      }
      // S-C2 soft-defer: 페인 핀 태스크 + 페인 신원 주장 호출자인데 callerAddr가
      // 해석되지 않은 경우(ptyId→pane 해석은 렌더러 소유) — 데몬이 ws-authz로
      // 통과시키면 오늘의 페인 게이트(a2aSlice)가 우회된다. 렌더러 검증 경로로
      // 폴백하도록 soft 거부한다(main의 A2A_DAEMON_SOFT_ERRORS 계약).
      if (input.callerHasPaneIdentity && !input.callerAddr && task.metadata.to.paneId) {
        return { ok: false, error: 'a2a.task.update: pane-authz deferred to renderer (pane-pinned task)' };
      }
      // VALID_TRANSITIONS 데몬측 강제(성공 종단='completed').
      if (!validateTransition(task.status.state, input.to)) {
        const from = task.status.state;
        const allowed = VALID_TRANSITIONS[from];
        const guidance = allowed.length
          ? `allowed next: [${allowed.join(', ')}]`
          : `'${from}' is a terminal state with no further transitions`;
        return { ok: false, error: `a2a.task.update: invalid transition ${from} -> ${input.to}. ${guidance}.` };
      }

      // evidence 수용만(§6.M PR-D′): wire 재정규화(sanitize) 후 verbatim 저장.
      // **완료증거 게이트(evidence 필수·verified≥1)는 없다** — Q1-4b/PR-B 소관.
      // 단 malformed shape는 PR-D′가 이미 렌더러 wire 경계에서 거부하던 위생 계약
      // (useRpcBridge completion_evidence_malformed)이므로 정본 게이트도 동형으로
      // 거부한다 — 조용히 드롭하면 렌더러(거부)와 데몬(커밋)이 갈라진다(split).
      let evidence: CompletionEvidence | undefined;
      let verifiedItemCount: number | undefined;
      if (input.evidence !== undefined) {
        const normalized = normalizeCompletionEvidenceWire(input.evidence);
        if (!normalized) {
          return {
            ok: false,
            error: 'a2a.task.update: completion_evidence_malformed: evidence must be a plain object with string summary and well-formed items',
          };
        }
        evidence = normalized;
        verifiedItemCount = normalized.items.filter(isVerifiedItem).length; // 감사 등급(게이트 아님)
      }

      const payload: A2aTaskTransitionPayload = {
        kind: 'task.transition',
        taskId: input.taskId,
        to: input.to,
        timestamp: this.isoNow(),
        ...(input.message ? { message: input.message } : {}),
        ...(evidence ? { evidence } : {}),
        ...(verifiedItemCount !== undefined ? { verifiedItemCount } : {}),
      };
      const authWs = input.callerWorkspaceId;
      const committed = await this.log.append(
        this.envelope(payload, authWs, input.idempotencyKey, input.principalId, input.trustTier),
      );
      if (!committed) {
        return { ok: false, error: 'a2a.task.update: daemon log append failed (uncommitted)' };
      }
      this.applyPayload(payload);

      const result: TransitionOk = {
        ok: true,
        ...(verifiedItemCount !== undefined ? { verifiedItemCount } : {}),
        task, // 커밋된 projection 스냅샷 — 캐시 verbatim 적용의 원본(C6)
      };
      this.idempotencyRecord(input.taskId, input.idempotencyKey, result);
      return result;
    });
  }

  /**
   * 취소 — sender/receiver 모두 가능. VALID_TRANSITIONS(→canceled) 강제.
   */
  cancelTask(input: CancelTaskInput): Promise<CancelOk | OpErr> {
    return this.withTaskLock(input.taskId, async () => {
      const cached = this.idempotencyHit(input.taskId, input.idempotencyKey);
      if (cached) return cached as CancelOk;

      const task = this.tasks.get(input.taskId);
      if (!task) return { ok: false, error: `a2a.task.cancel: task not found: ${input.taskId}` };

      const isSender = task.metadata.from.workspaceId === input.callerWorkspaceId;
      const isReceiver = task.metadata.to.workspaceId === input.callerWorkspaceId;
      if (!isSender && !isReceiver) {
        return { ok: false, error: `a2a.task.cancel: caller ${input.callerWorkspaceId} is not sender or receiver` };
      }
      // G(패널): 이미 종단이면 멱등 no-op 성공 — 취소의 목적(종단 도달)이 이미
      // 충족됐다. reject하면 종전 렌더러 passthrough 경로 대비 회귀다(호출자는
      // 취소를 눌렀는데 에러를 받는다). 로그 append 없이 현 상태 반환.
      if ((TERMINAL_STATES as readonly string[]).includes(task.status.state)) {
        return { ok: true, task };
      }
      if (!validateTransition(task.status.state, 'canceled')) {
        return { ok: false, error: `a2a.task.cancel: cannot cancel task in state ${task.status.state}` };
      }

      const payload: A2aTaskCancelPayload = {
        kind: 'task.cancel',
        taskId: input.taskId,
        timestamp: this.isoNow(),
      };
      const committed = await this.log.append(
        this.envelope(payload, input.callerWorkspaceId, input.idempotencyKey, input.principalId, input.trustTier),
      );
      if (!committed) {
        return { ok: false, error: 'a2a.task.cancel: daemon log append failed (uncommitted)' };
      }
      this.applyPayload(payload);
      const result: CancelOk = { ok: true, task };
      this.idempotencyRecord(input.taskId, input.idempotencyKey, result);
      return result;
    });
  }

  /**
   * B(패널·완료증거 설계 §③ E10) — workspace teardown 전용 강제-실패 진입점.
   * 수신 workspace가 제거되면 그 workspace로 향한 non-terminal 태스크는 어떤
   * 전진도 불가하다(수신자 소멸). `VALID_TRANSITIONS`를 **의도적으로 우회**해
   * (submitted/input-required→failed는 그래프상 불가) failed로 커밋한다 —
   * 일반 transition API는 이 전이를 여전히 거부한다(진입점이 그래프 완화가 아님).
   *
   * 이게 없으면 teardown이 렌더러 캐시에서만 태스크를 죽이고 데몬 정본엔 미도달 →
   * 재시작 시 restoreFromLog가 죽은 태스크를 working/submitted로 부활시켜 정본이
   * 실제와 어긋난다(내구성 정본 주장 훼손). 데몬 부트 게이트가 workspace 제거를
   * 아는 유일 지점(a2a.channel.purgeMembership 핸들러)에서 호출된다.
   *
   * @returns 실제로 failed로 커밋된 태스크 수.
   */
  async failTasksForWorkspaceRemoved(workspaceId: string, reason: string): Promise<number> {
    // 스냅샷 후 순회 — 락 안에서 status가 바뀌므로 순회 중 Map 변형 회피.
    const targets = [...this.tasks.values()].filter(
      (t) =>
        t.metadata.to.workspaceId === workspaceId &&
        !(TERMINAL_STATES as readonly string[]).includes(t.status.state),
    );
    let failed = 0;
    for (const target of targets) {
      // eslint-disable-next-line no-await-in-loop -- per-task 직렬화(정상 전이와 순서 보장)
      const ok = await this.withTaskLock(target.id, async () => {
        // 락 대기 중 정상 전이로 종단됐으면 멱등 skip(이중 커밋 방지).
        const cur = this.tasks.get(target.id);
        if (!cur || (TERMINAL_STATES as readonly string[]).includes(cur.status.state)) return false;
        const payload: A2aTaskTransitionPayload = {
          kind: 'task.transition',
          taskId: target.id,
          to: 'failed',
          timestamp: this.isoNow(),
          forced: 'workspace_removed',
          // 합성 완료증거(§③ E10): 실패 사유만(items 없음 — failed는 검증 불변식
          // 미적용). PR4는 evidence 수용만이므로 게이트 없이 그대로 저장된다.
          evidence: { summary: reason, items: [] },
        };
        const committed = await this.log.append(this.envelope(payload, workspaceId));
        if (!committed) return false;
        this.applyPayload(payload);
        return true;
      });
      if (ok) failed++;
    }
    return failed;
  }

  // ── read ───────────────────────────────────────────────────────────

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  queryTasks(workspaceId: string, filters?: QueryFilters): Task[] {
    const out: Task[] = [];
    for (const task of this.tasks.values()) {
      const isSender = task.metadata.from.workspaceId === workspaceId;
      const isReceiver = task.metadata.to.workspaceId === workspaceId;
      if (!isSender && !isReceiver) continue;
      if (filters?.role === 'user' && !isSender) continue;
      if (filters?.role === 'agent' && !isReceiver) continue;
      if (filters?.status && task.status.state !== filters.status) continue;
      // 증분 커서(A9): ISO-8601 문자열 사전순=시간순. strictly-after.
      if (filters?.updatedSince && !(task.metadata.updatedAt > filters.updatedSince)) continue;
      out.push(task);
    }
    return out;
  }

  /** 관측용(테스트/디버그): 현재 projection 태스크 수. */
  get taskCount(): number {
    return this.tasks.size;
  }

  // ── GC (projection 레벨, 로그 절단 아님) ────────────────────────────

  /**
   * 30분 초과 종단 태스크 제거 + 하드캡 초과 시 오래된 것부터 축출(종단 우선).
   * a2aSlice.gcTerminalTasks와 동형 — 정본은 로그이므로 여기 GC는 캐시 바운드다
   * (컴팩션이 로그 상주분을 별도로 바운드; §9). 로그를 절단하지 않는다.
   */
  gcTerminalTasks(): void {
    const now = this.now();
    for (const [id, task] of this.tasks) {
      if (
        (TERMINAL_STATES as readonly string[]).includes(task.status.state) &&
        now - new Date(task.metadata.updatedAt).getTime() > GC_MAX_AGE_MS
      ) {
        this.tasks.delete(id);
        this.idempotency.delete(id);
      }
    }
    if (this.tasks.size <= GC_MAX_TASKS) return;
    let toRemove = this.tasks.size - GC_MAX_TASKS;
    const oldestFirst = [...this.tasks.values()].sort(
      (a, b) => new Date(a.metadata.updatedAt).getTime() - new Date(b.metadata.updatedAt).getTime(),
    );
    const isTerminal = (t: Task) => (TERMINAL_STATES as readonly string[]).includes(t.status.state);
    const order = [...oldestFirst.filter(isTerminal), ...oldestFirst.filter((t) => !isTerminal(t))];
    for (const task of order) {
      if (toRemove <= 0) break;
      this.tasks.delete(task.id);
      this.idempotency.delete(task.id);
      toRemove--;
    }
  }

  // ── 내부 ────────────────────────────────────────────────────────────

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }

  private generateTaskId(): string {
    // a2aSlice generateId('task')와 동형 — 조정 없는 유일 id.
    return `task-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /** makeEnvelope 초안 조립(발급 필드는 append 소관). */
  private envelope(
    payload: unknown,
    verifiedWorkspaceId: string,
    idempotencyKey?: string,
    principalId?: string,
    trustTier?: TrustTier,
  ): EventEnvelopeDraft {
    return makeEnvelope({
      domain: 'a2a',
      payload,
      origin: this.origin,
      authContext: this.buildAuthContext(verifiedWorkspaceId, principalId, trustTier),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  /**
   * authContext 조립. verifiedWorkspaceId(서버핀 authz 앵커)는 호출자 제공값.
   * principalId/trustTier의 정본 스탬핑은 PR5 소관 — 여기선 보수적 기본값
   * (trustTier='semi-trusted': A2A execute는 우리가 spawn한 ClaudeWorker, §7 표).
   */
  private buildAuthContext(
    verifiedWorkspaceId: string,
    principalId?: string,
    trustTier?: TrustTier,
  ): AuthContext {
    return {
      principalId: principalId ?? '',
      verifiedWorkspaceId,
      trustTier: trustTier ?? 'semi-trusted',
    };
  }

  private idempotencyHit(
    taskId: string,
    key: string | undefined,
  ): TransitionOk | CancelOk | undefined {
    if (!key) return undefined;
    return this.idempotency.get(taskId)?.get(key);
  }

  private idempotencyRecord(
    taskId: string,
    key: string | undefined,
    result: TransitionOk | CancelOk,
  ): void {
    if (!key) return;
    let stream = this.idempotency.get(taskId);
    if (!stream) {
      stream = new Map();
      this.idempotency.set(taskId, stream);
    }
    stream.set(key, result);
    // LRU: Map은 삽입 순서를 보존 — cap 초과 시 가장 오래된 키부터 축출.
    while (stream.size > IDEMPOTENCY_CAP) {
      const oldest = stream.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      stream.delete(oldest);
    }
  }

  /**
   * per-task 직렬화. prev 체인 뒤에 fn을 잇고, 다음 대기자가 prev 실패로 거부되지
   * 않도록 저장 체인은 에러를 삼킨다(ChannelService.withChannelLock 동형). 테일에서
   * 정착 시 항목을 정리해 locks 맵을 바운드한다.
   */
  private withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(taskId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const chain = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(taskId, chain);
    void chain.then(() => {
      if (this.locks.get(taskId) === chain) this.locks.delete(taskId);
    });
    return run;
  }
}
