import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Absolute path to Windows PowerShell. A bare `powershell.exe` spawn relies
 * on PATH containing System32, which real-world machines lack surprisingly
 * often (X1 dogfood 2026-06-12: only System32\OpenSSH was on PATH → every
 * snapshot died ENOENT and ports silently never rendered). Same
 * SystemRoot-anchored resolution the daemon uses for wmic/tasklist.
 */
function windowsPowershellPath(): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * X1 workspace-context sidebar — per-session listening-port tracking.
 *
 * Frozen contract (docs/internal/fable-window-schema-freeze.md §2):
 *   - `listeningPorts`: daemon PID tree → `Get-NetTCPConnection
 *     -OwningProcess`, 10 s interval.
 *   - Daemon broadcasts `{ type: 'context.ports', sessionId,
 *     data: { ports: Array<{ port: number, pid: number }> } }`.
 *
 * Unlike the old MetadataCollector path (which listed the FIRST 20 ports of
 * the whole machine for every workspace), ports are matched against each
 * session's process tree, so "3000 is listening" is attributed to the pane
 * that actually owns the dev server.
 *
 * One snapshot pair per tick regardless of session count: a full
 * pid→ppid table + a full listening-socket table, then per-session
 * descendant matching in-process.
 */

export interface SessionPort {
  port: number;
  pid: number;
}

export interface PortSnapshot {
  /** child pid → parent pid for every live process. */
  ppidByPid: Map<number, number>;
  /** Every listening TCP socket on the machine. */
  listeners: SessionPort[];
}

export type SnapshotFn = () => Promise<PortSnapshot>;

const DEFAULT_INTERVAL_MS = 10_000;
/** Snapshot subprocess timeout — must stay well under the tick interval. */
const SNAPSHOT_TIMEOUT_MS = 8_000;

/** Windows: one PowerShell call returns both tables as compact JSON. */
async function snapshotWindows(): Promise<PortSnapshot> {
  const script =
    '$p=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId,ParentProcessId;' +
    '$c=Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort,OwningProcess;' +
    '@{procs=@($p);conns=@($c)} | ConvertTo-Json -Depth 3 -Compress';
  const { stdout } = await execFileAsync(windowsPowershellPath(), ['-NoProfile', '-Command', script], {
    timeout: SNAPSHOT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as {
    procs?: Array<{ ProcessId?: number; ParentProcessId?: number }> | null;
    conns?: Array<{ LocalPort?: number; OwningProcess?: number }> | null;
  };
  const ppidByPid = new Map<number, number>();
  for (const p of parsed.procs ?? []) {
    if (typeof p?.ProcessId === 'number' && typeof p?.ParentProcessId === 'number') {
      ppidByPid.set(p.ProcessId, p.ParentProcessId);
    }
  }
  const listeners: SessionPort[] = [];
  for (const c of parsed.conns ?? []) {
    if (typeof c?.LocalPort === 'number' && typeof c?.OwningProcess === 'number' && c.OwningProcess > 4) {
      listeners.push({ port: c.LocalPort, pid: c.OwningProcess });
    }
  }
  return { ppidByPid, listeners };
}

/** Unix: `ps` for the process table + `lsof` for listening sockets. */
async function snapshotUnix(): Promise<PortSnapshot> {
  const ppidByPid = new Map<number, number>();
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid='], {
      timeout: SNAPSHOT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) ppidByPid.set(Number(m[1]), Number(m[2]));
    }
  } catch { /* best-effort */ }

  const listeners: SessionPort[] = [];
  try {
    // -F p n: machine-readable "p<pid>" / "n<addr>" lines.
    const { stdout } = await execFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], {
      timeout: SNAPSHOT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    let currentPid: number | null = null;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) {
        currentPid = Number(line.slice(1)) || null;
      } else if (line.startsWith('n') && currentPid !== null) {
        const m = line.match(/:(\d+)$/);
        if (m) listeners.push({ port: Number(m[1]), pid: currentPid });
      }
    }
  } catch { /* lsof missing or denied — silently no ports */ }
  return { ppidByPid, listeners };
}

export function defaultSnapshot(): Promise<PortSnapshot> {
  return process.platform === 'win32' ? snapshotWindows() : snapshotUnix();
}

/**
 * Match a snapshot against a set of session root PIDs. Exported for the
 * daemon wiring and unit tests — pure, no I/O.
 */
export function matchSessionPorts(
  snapshot: PortSnapshot,
  sessions: Array<{ sessionId: string; pid: number }>,
): Map<string, SessionPort[]> {
  // Invert ppid→children once; BFS per session over its descendants.
  const childrenByPid = new Map<number, number[]>();
  for (const [pid, ppid] of snapshot.ppidByPid) {
    const arr = childrenByPid.get(ppid);
    if (arr) arr.push(pid);
    else childrenByPid.set(ppid, [pid]);
  }

  const result = new Map<string, SessionPort[]>();
  for (const { sessionId, pid } of sessions) {
    const tree = new Set<number>([pid]);
    const queue = [pid];
    while (queue.length > 0) {
      const cur = queue.pop() as number;
      for (const child of childrenByPid.get(cur) ?? []) {
        if (!tree.has(child)) {
          tree.add(child);
          queue.push(child);
        }
      }
    }
    const seen = new Set<string>();
    const ports: SessionPort[] = [];
    for (const l of snapshot.listeners) {
      if (!tree.has(l.pid)) continue;
      const key = `${l.port}:${l.pid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ports.push(l);
    }
    ports.sort((a, b) => a.port - b.port || a.pid - b.pid);
    result.set(sessionId, ports);
  }
  return result;
}

/**
 * Polls listening ports every `intervalMs` and emits per-session diffs.
 *
 * Events:
 *  - 'ports' → { sessionId: string, ports: SessionPort[] }
 *
 * Emits only when a session's port set actually changed (including the
 * transition back to empty, so the sidebar clears a dead dev server).
 */
export class PortWatcher extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastBySession = new Map<string, string>();
  private readonly intervalMs: number;
  private readonly snapshot: SnapshotFn;

  constructor(
    private getSessions: () => Array<{ sessionId: string; pid: number }>,
    opts: { intervalMs?: number; snapshot?: SnapshotFn } = {},
  ) {
    super();
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.snapshot = opts.snapshot ?? defaultSnapshot;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.lastBySession.clear();
  }

  /** One poll cycle. Public so tests (and the daemon on session-create) can drive it. */
  async tick(): Promise<void> {
    if (this.ticking) return; // a slow snapshot must not stack subprocesses
    this.ticking = true;
    try {
      const sessions = this.getSessions().filter(
        (s) => Number.isInteger(s.pid) && s.pid > 0,
      );

      // Sessions that disappeared: drop diff state so a recreated session
      // with the same id re-emits its first non-empty set.
      const liveIds = new Set(sessions.map((s) => s.sessionId));
      for (const id of this.lastBySession.keys()) {
        if (!liveIds.has(id)) this.lastBySession.delete(id);
      }
      if (sessions.length === 0) return;

      const snap = await this.snapshot();
      const matched = matchSessionPorts(snap, sessions);
      for (const [sessionId, ports] of matched) {
        const encoded = JSON.stringify(ports);
        const prev = this.lastBySession.get(sessionId);
        // First observation with no ports is a no-op (nothing to clear).
        if (prev === undefined && ports.length === 0) continue;
        if (encoded === prev) continue;
        this.lastBySession.set(sessionId, encoded);
        this.emit('ports', { sessionId, ports });
      }
    } catch {
      // Snapshot failure (PowerShell missing, lsof denied) — silent; the
      // sidebar simply shows no ports, matching the "quiet absence" policy.
    } finally {
      this.ticking = false;
    }
  }
}
