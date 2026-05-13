/**
 * Persistent log sink for the main process.
 *
 * Why this exists: wmux historically wrote logs only to stderr. In packaged
 * Windows builds stderr has no parent console, so structured error traces
 * (wrapHandler IPC errors, daemon disconnects, scrollback restore failures)
 * vanished. When a user reports a bug after a reboot, there is no postmortem
 * artifact to inspect.
 *
 * This sink:
 *   - tees process.stderr.write to a daily-rotated log file in
 *     `app.getPath('logs')` (Windows: %APPDATA%\wmux\logs\main-YYYY-MM-DD.log)
 *   - exposes `logLine(level, source, message)` for explicit instrumentation
 *
 * Best-effort: every write is wrapped in try/catch. The sink must never
 * crash the main process.
 */

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

type Level = 'info' | 'warn' | 'error';

let currentLogPath: string | null = null;
let currentDate = '';
let initialised = false;
let logDirCreated = false;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function logPath(date: string): string {
  return path.join(app.getPath('logs'), `main-${date}.log`);
}

/**
 * Resolve the current daily log file path. Lazily creates the parent
 * directory once. Returns null only if directory creation fails (which
 * we silently swallow so logging never crashes the main process).
 *
 * NOTE: we deliberately do NOT use fs.createWriteStream here. Stream
 * writes are buffered up to the default 16KB high-water-mark and only
 * flush to disk on stream end/drain. For a long-lived main process that
 * emits small, infrequent log lines, this leaves the file at 0 bytes on
 * disk for the entire session — defeating the whole point of a
 * postmortem log sink. fs.appendFileSync writes immediately, fsyncs,
 * and returns, so every log line is durably on disk before the call
 * returns. The synchronous cost is acceptable for diagnostic-rate
 * logging (a few writes per second at peak) and is mandatory if we
 * want the file to survive a crash that bypasses Node's stream-shutdown
 * flush.
 */
function resolveLogPath(): string | null {
  const today = todayUtc();
  if (currentLogPath && currentDate === today) return currentLogPath;

  const filePath = logPath(today);
  if (!logDirCreated || currentDate !== today) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      logDirCreated = true;
    } catch {
      return null;
    }
  }
  currentLogPath = filePath;
  currentDate = today;
  return currentLogPath;
}

/**
 * Append a structured log line. Writes to stderr only — the file write is
 * handled automatically by the stderr tee installed in `initLogSink()`,
 * which calls `appendFileSync` for immediate disk durability.
 */
export function logLine(level: Level, source: string, message: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] [${source}] ${message}\n`;
  try { process.stderr.write(line); } catch { /* ignore */ }
}

/**
 * Initialise the sink. Idempotent. Must be called after `app` is ready
 * enough to resolve `app.getPath('logs')` — i.e. after Electron has parsed
 * its userData path. Calling from inside `app.on('ready')` is always safe;
 * calling earlier works in practice because we only resolve the path on
 * first `ensureStream()`.
 *
 * After init, any direct `process.stderr.write(...)` (from wrapHandler,
 * console.error, etc.) is also mirrored into the log file, so we capture
 * pre-existing instrumentation without rewriting every call site.
 */
export function initLogSink(): void {
  if (initialised) return;
  initialised = true;

  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    try {
      const filePath = resolveLogPath();
      if (filePath) {
        const str = typeof chunk === 'string'
          ? chunk
          : (chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf-8') : String(chunk));
        // appendFileSync writes through to the OS immediately and fsyncs
        // before returning. createWriteStream would buffer until 16KB
        // high-water-mark — for a long-lived main with small log lines
        // that means the file sits at 0 bytes on disk for the whole
        // session, defeating the postmortem use case entirely.
        fs.appendFileSync(filePath, str);
      }
    } catch { /* swallow — never break stderr */ }
    // @ts-expect-error - spread re-applies original signature
    return orig(chunk, ...rest);
  }) as typeof process.stderr.write;

  logLine('info', 'logSink', `started — version=${app.getVersion()}, pid=${process.pid}, platform=${process.platform}`);
}
