/**
 * Atomic JSON read/write primitives.
 *
 * Extracted from the duplicate logic in `StateWriter.ts` and
 * `SessionManager.ts`. This is the T1a scaffold — the interface is
 * frozen here so later phases can layer extra behaviour without
 * changing call sites:
 *
 *   - T1b: StateWriter / SessionManager migrate to these helpers.
 *   - T5:  rotation (tmp → primary → .bak → .bak.1 chain). The
 *          `rotationEnabled` flag is wired in already; it is a
 *          no-op for now.
 *   - T6:  corrupt-file quarantine. The `validate` hook exists and
 *          read-time failures fall back to returning `null`; the
 *          quarantine path will replace the warn-and-continue
 *          behaviour.
 *   - T7:  lazy migrations. The `migrator` hook exists and is
 *          accepted but unused today.
 *
 * Scope guard: this module must not depend on Electron or on any
 * module that reaches into daemon-specific state. It only uses
 * `node:fs`, `node:path`, and `node:process` so both the daemon
 * and the main process can consume it once the migration lands in
 * T1b.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  BACKUP_SUFFIXES,
  rotateBackups,
  rotateBackupsSync,
} from './rotation';

// ── Public types ─────────────────────────────────────────────────────

export interface AtomicWriteOptions {
  /**
   * When true, T5's rotation chain takes over (primary → .bak →
   * .bak.1 …). **No-op in T1a.**
   */
  rotationEnabled?: boolean;

  /**
   * Optional pre-write validator. Called with the data the caller
   * supplied _before_ serialization. Throwing or returning `false`
   * causes the write to abort with an error — the on-disk file is
   * left untouched.
   */
  validate?: (data: unknown) => boolean;

  /**
   * Injectable clock for tests. Defaults to `Date.now`.
   * T6 uses this for quarantine timestamps.
   */
  clock?: () => number;
}

export interface AtomicReadOptions<T> {
  /**
   * Post-parse validator/type guard. When it returns false we
   * discard the parsed value and try the `.bak` fallback; if that
   * also fails we return `null`. T6 will replace this warn-and-null
   * path with isolation-to-quarantine.
   */
  validate?: (data: unknown) => data is T;

  /**
   * T7 lazy-migration hook. Receives the parsed (and prototype-
   * sanitised) value plus the detected schema version, and must
   * return the migrated payload with a new version. **No-op in
   * T1a** — current behaviour is as if the hook was not supplied.
   */
  migrator?: (
    data: unknown,
    fromVersion: number,
  ) => { data: T; version: number };

  /** Injectable clock for tests. Defaults to `Date.now`. */
  clock?: () => number;
}

// ── Internal helpers ─────────────────────────────────────────────────

const JSON_INDENT = 2;

/**
 * Recursively strip prototype-pollution keys from a parsed JSON
 * payload. Matches the reviver used by the original StateWriter /
 * SessionManager implementations. We apply this as a reviver so the
 * keys are dropped _during_ parsing and never attached to any
 * object.
 */
function jsonReviver(key: string, value: unknown): unknown {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    return undefined;
  }
  return value;
}

/**
 * Unique-ish tmp path. Using PID (plus a monotonic counter) keeps
 * concurrent writers in different processes from clobbering each
 * other's in-flight tmp file. Within a single process the counter
 * avoids collisions when two writes interleave.
 */
let tmpCounter = 0;
function makeTmpPath(targetPath: string): string {
  tmpCounter = (tmpCounter + 1) >>> 0;
  return `${targetPath}.tmp.${process.pid}.${tmpCounter}`;
}

function bakPathFor(targetPath: string): string {
  return `${targetPath}.bak`;
}

function ensureDirSync(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function ensureDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
}

function serialise(data: unknown): string {
  return JSON.stringify(data, null, JSON_INDENT);
}

function parseJSONSafe(raw: string): unknown {
  // JSON.parse throws on invalid JSON — callers handle that and fall
  // back to `.bak` or return `null`.
  return JSON.parse(raw, jsonReviver);
}

function detectVersion(data: unknown): number {
  if (typeof data === 'object' && data !== null) {
    const v = (data as Record<string, unknown>)['version'];
    if (typeof v === 'number') return v;
  }
  return 0;
}

/** Unlink, swallowing ENOENT. */
function unlinkIfExistsSync(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // Don't crash cleanup — best effort.
    }
  }
}

async function unlinkIfExists(p: string): Promise<void> {
  try {
    await fsp.unlink(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // swallow; cleanup is best-effort
    }
  }
}

// ── Async write ──────────────────────────────────────────────────────

export async function atomicWriteJSON(
  targetPath: string,
  data: unknown,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  if (opts.validate) {
    let ok = false;
    try {
      ok = opts.validate(data);
    } catch (err) {
      throw new Error(
        `atomicWriteJSON: validate() threw for "${targetPath}": ${String(err)}`,
      );
    }
    if (!ok) {
      throw new Error(
        `atomicWriteJSON: validate() rejected payload for "${targetPath}"`,
      );
    }
  }

  const tmp = makeTmpPath(targetPath);
  const bak = bakPathFor(targetPath);

  await ensureDir(targetPath);

  const json = serialise(data);

  try {
    // 1. Write to temp file. mode:0o600 is a no-op on Windows, but
    //    matches the StateWriter's POSIX intent.
    await fsp.writeFile(tmp, json, { encoding: 'utf-8', mode: 0o600 });

    // 2. When rotation is enabled we shift the existing numbered
    //    slots BEFORE overwriting `.bak` so nothing is lost:
    //      .bak.2 → .bak.3, .bak.1 → .bak.2, .bak → .bak.1.
    //    With rotation off we keep the historical single-slot
    //    behaviour (current `.bak` is overwritten by step 3).
    if (opts.rotationEnabled) {
      await rotateBackups(targetPath);
    }

    // 3. Rotate current → .bak (best-effort).
    try {
      await fsp.rename(targetPath, bak);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // eslint-disable-next-line no-console
        console.warn('[atomicWrite] Failed to create backup:', err);
      }
    }

    // 4. Atomic rename tmp → target.
    await fsp.rename(tmp, targetPath);
  } catch (err) {
    // Best-effort tmp cleanup so we don't leak partial files.
    await unlinkIfExists(tmp);
    throw err;
  }
}

// ── Async read ───────────────────────────────────────────────────────

async function readParsed(filePath: string): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
  if (!raw) return null;
  return parseJSONSafe(raw);
}

export async function atomicReadJSON<T>(
  targetPath: string,
  opts: AtomicReadOptions<T> = {},
): Promise<T | null> {
  const attempt = async (p: string, label: 'primary' | 'backup'): Promise<T | null> => {
    let parsed: unknown;
    try {
      parsed = await readParsed(p);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[atomicRead] ${label} parse failed for "${p}":`, err);
      return null;
    }
    if (parsed === null) return null;

    // T7: lazy migration. If a migrator hook is supplied we run it
    // against the detected schema version. A throwing hook is
    // treated as a parse-level failure — we warn and return null so
    // the fallback chain picks up a `.bak` (and, once T6 lands, a
    // quarantine handoff). The migrator's `version` is informational;
    // `atomicReadJSON` intentionally exposes only the payload to keep
    // the public surface narrow. Persisting the upgraded payload is
    // the caller's responsibility and normally happens on the next
    // write.
    if (opts.migrator) {
      const fromVersion = detectVersion(parsed);
      try {
        const result = opts.migrator(parsed, fromVersion);
        parsed = result.data;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[atomicRead] migrator failed for ${label} "${p}":`,
          err,
        );
        return null;
      }
    }

    if (opts.validate && !opts.validate(parsed)) {
      // TODO(T6): route `parsed` + source path to the quarantine
      // helper instead of dropping it silently. For T1a we match
      // the historical "return null and warn" behaviour.
      // eslint-disable-next-line no-console
      console.warn(`[atomicRead] validate() rejected ${label} "${p}"`);
      return null;
    }

    return parsed as T;
  };

  // Fallback chain: primary → .bak → .bak.1 → .bak.2 → .bak.3. This
  // is deliberately independent of `rotationEnabled`: a legacy
  // single-`.bak` file still participates, and rotated archives
  // added by T5 become usable without any call-site change.
  const primary = await attempt(targetPath, 'primary');
  if (primary !== null) return primary;

  for (const suffix of BACKUP_SUFFIXES) {
    const candidate = `${targetPath}${suffix}`;
    const backup = await attempt(candidate, 'backup');
    if (backup !== null) return backup;
  }

  return null;
}

// ── Sync write (emergency save paths) ────────────────────────────────

export function atomicWriteJSONSync(
  targetPath: string,
  data: unknown,
  opts: AtomicWriteOptions = {},
): void {
  if (opts.validate) {
    let ok = false;
    try {
      ok = opts.validate(data);
    } catch (err) {
      throw new Error(
        `atomicWriteJSONSync: validate() threw for "${targetPath}": ${String(err)}`,
      );
    }
    if (!ok) {
      throw new Error(
        `atomicWriteJSONSync: validate() rejected payload for "${targetPath}"`,
      );
    }
  }

  const tmp = makeTmpPath(targetPath);
  const bak = bakPathFor(targetPath);

  ensureDirSync(targetPath);

  const json = serialise(data);

  try {
    fs.writeFileSync(tmp, json, { encoding: 'utf-8', mode: 0o600 });

    // Shift the numbered slots up when rotation is enabled so the
    // upcoming `.bak` overwrite does not drop a generation. See the
    // async variant for the slot-order rationale.
    if (opts.rotationEnabled) {
      rotateBackupsSync(targetPath);
    }

    if (fs.existsSync(targetPath)) {
      try {
        fs.renameSync(targetPath, bak);
      } catch (bakErr) {
        // eslint-disable-next-line no-console
        console.warn('[atomicWrite] Failed to create backup:', bakErr);
      }
    }

    fs.renameSync(tmp, targetPath);
  } catch (err) {
    unlinkIfExistsSync(tmp);
    throw err;
  }
}

// ── Sync read ────────────────────────────────────────────────────────

function readParsedSync(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf-8');
  if (!raw) return null;
  return parseJSONSafe(raw);
}

export function atomicReadJSONSync<T>(
  targetPath: string,
  opts: AtomicReadOptions<T> = {},
): T | null {
  const attempt = (p: string, label: 'primary' | 'backup'): T | null => {
    let parsed: unknown;
    try {
      parsed = readParsedSync(p);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[atomicRead] ${label} parse failed for "${p}":`, err);
      return null;
    }
    if (parsed === null) return null;

    // T7: sync counterpart of the async migrator path above. See
    // `atomicReadJSON` for the design rationale.
    if (opts.migrator) {
      const fromVersion = detectVersion(parsed);
      try {
        const result = opts.migrator(parsed, fromVersion);
        parsed = result.data;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[atomicRead] migrator failed for ${label} "${p}":`,
          err,
        );
        return null;
      }
    }

    if (opts.validate && !opts.validate(parsed)) {
      // TODO(T6): quarantine instead of warn+null.
      // eslint-disable-next-line no-console
      console.warn(`[atomicRead] validate() rejected ${label} "${p}"`);
      return null;
    }

    return parsed as T;
  };

  // Same fallback walk as the async variant; see there for the
  // rationale on being rotation-agnostic.
  const primary = attempt(targetPath, 'primary');
  if (primary !== null) return primary;

  for (const suffix of BACKUP_SUFFIXES) {
    const candidate = `${targetPath}${suffix}`;
    const backup = attempt(candidate, 'backup');
    if (backup !== null) return backup;
  }

  return null;
}
