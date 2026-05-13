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

let logStream: fs.WriteStream | null = null;
let currentDate = '';
let initialised = false;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function logPath(date: string): string {
  return path.join(app.getPath('logs'), `main-${date}.log`);
}

function ensureStream(): fs.WriteStream | null {
  const today = todayUtc();
  if (logStream && currentDate === today) return logStream;

  // Date rolled over — close previous handle before opening a new one.
  if (logStream) {
    try { logStream.end(); } catch { /* ignore */ }
    logStream = null;
  }

  try {
    const filePath = logPath(today);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    logStream = fs.createWriteStream(filePath, { flags: 'a' });
    currentDate = today;
    return logStream;
  } catch {
    logStream = null;
    return null;
  }
}

/**
 * Append a structured log line. Writes to stderr only — the file write is
 * handled automatically by the stderr tee installed in `initLogSink()`.
 * Writing to the file directly here would double-log every line because
 * the tee already intercepts our stderr write.
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
      const stream = ensureStream();
      if (stream) {
        const str = typeof chunk === 'string'
          ? chunk
          : (chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf-8') : String(chunk));
        stream.write(str);
      }
    } catch { /* swallow — never break stderr */ }
    // @ts-expect-error - spread re-applies original signature
    return orig(chunk, ...rest);
  }) as typeof process.stderr.write;

  logLine('info', 'logSink', `started — version=${app.getVersion()}, pid=${process.pid}, platform=${process.platform}`);
}
