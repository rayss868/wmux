/**
 * T13 — persistence end-to-end scenarios.
 *
 * This suite targets the *three-way* interactions between migration,
 * rotation, and corruption quarantine. T10 (rotation integration,
 * corruption integration) and T11 (migration chaining) pair the
 * features two-at-a-time; this file exercises scenarios where all
 * three features participate in the same read/write cycle or where
 * the edge cases of one feature constrain the expected behaviour of
 * another.
 *
 * Ground rules (inherited from T10/T11):
 *   - No source-code edits.
 *   - Each `it` gets a fresh tmp directory scrubbed on teardown.
 *   - Fake clocks keep quarantine filenames deterministic.
 *   - stderr capture suppresses CORRUPT_FILE log lines from the test
 *     output buffer so the surrounding vitest report stays quiet.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  atomicWriteJSON,
  atomicReadJSON,
} from '../core';
import {
  createMigrator,
  type MigrationRegistry,
} from '../migrate';

// ── Shared fixtures ──────────────────────────────────────────────────

interface SessionV1 {
  version: 1;
  workspaceId: string;
  panes: Array<{ id: string; cwd: string }>;
}
interface SessionV2 {
  version: 2;
  workspaceId: string;
  panes: Array<{ id: string; cwd: string; scrollbackLimit: number }>;
}

const V1_FIXTURE_PATH = path.join(__dirname, 'fixtures', 'session.v1.json');
const V2_FIXTURE_PATH = path.join(__dirname, 'fixtures', 'session.v2.json');

function loadV1(): SessionV1 {
  return JSON.parse(fs.readFileSync(V1_FIXTURE_PATH, 'utf-8')) as SessionV1;
}
function loadV2(): SessionV2 {
  return JSON.parse(fs.readFileSync(V2_FIXTURE_PATH, 'utf-8')) as SessionV2;
}

/**
 * Registry that upgrades v1 → v2 by defaulting the new
 * `scrollbackLimit` field. Kept local so we never drift against the
 * production `SESSION_DATA_REGISTRY` (which ships as identity).
 */
const V1_TO_V2: MigrationRegistry = {
  currentVersion: 2,
  steps: [
    {
      fromVersion: 1,
      toVersion: 2,
      migrate: (input: unknown): SessionV2 => {
        const v1 = input as SessionV1;
        return {
          version: 2,
          workspaceId: v1.workspaceId,
          panes: v1.panes.map((p) => ({ ...p, scrollbackLimit: 1000 })),
        };
      },
    },
  ],
};

const isV2 = (d: unknown): d is SessionV2 =>
  typeof d === 'object' &&
  d !== null &&
  (d as Record<string, unknown>)['version'] === 2;

// ── tmpdir scaffolding ───────────────────────────────────────────────

let tmpDir: string;
let targetPath: string;
let corruptedDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `wmux-t13-persistence-${Date.now()}-`),
  );
  targetPath = path.join(tmpDir, 'session.json');
  corruptedDir = path.join(tmpDir, 'corrupted');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Capture stderr lines so CORRUPT_FILE log output does not pollute
 * the test runner buffer. Returns the captured lines + a restore
 * hook. Mirrors the pattern used in `corruption.integration.test.ts`.
 */
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown): boolean => {
      if (typeof chunk === 'string') lines.push(chunk);
      else if (chunk instanceof Uint8Array)
        lines.push(Buffer.from(chunk).toString('utf-8'));
      return true;
    });
  return { lines, restore: () => spy.mockRestore() };
}

function premigratePathFor(p: string, v: number): string {
  return `${p}.v${v}.premigrate.bak`;
}

function readJSONIfExists<T>(p: string): T | undefined {
  if (!fs.existsSync(p)) return undefined;
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
}

// ── Scenario A: Migration + Rotation coexistence ─────────────────────

describe('T13-A: migration + rotation coexistence', () => {
  it(
    'case A1: v1 on disk → atomicReadJSON(migrator) yields v2 + premigrate.bak; ' +
      'next rotationEnabled write lands v2 as primary and preserves .bak chain',
    async () => {
      // Seed a v1 primary. No .bak exists yet, so the first
      // rotation-enabled write will produce .bak but not .bak.1.
      fs.copyFileSync(V1_FIXTURE_PATH, targetPath);

      // 1. Load via the migrator hook. createMigrator is supposed to
      //    drop a v1.premigrate.bak snapshot *before* invoking the
      //    chain, so the sentinel should already be present when the
      //    read returns.
      const loaded = await atomicReadJSON<SessionV2>(targetPath, {
        migrator: createMigrator<SessionV2>(V1_TO_V2, targetPath),
      });

      expect(loaded).not.toBeNull();
      expect(loaded).toEqual({
        ...loadV2(),
      });

      // premigrate.bak must exist and still contain the on-disk v1
      // payload — the engine is write-once so nothing later mutates it.
      const premigrate = premigratePathFor(targetPath, 1);
      expect(fs.existsSync(premigrate)).toBe(true);
      expect(JSON.parse(fs.readFileSync(premigrate, 'utf-8'))).toEqual(
        loadV1(),
      );

      // atomicReadJSON does not persist the migrated payload — the
      // caller does. Primary on disk is still the v1 bytes.
      expect(readJSONIfExists<SessionV1>(targetPath)).toEqual(loadV1());

      // 2. Caller persists the upgraded payload with rotation on.
      await atomicWriteJSON(targetPath, loaded, { rotationEnabled: true });

      // primary advanced to v2; the previous v1 primary moved to .bak.
      expect(readJSONIfExists<SessionV2>(targetPath)).toEqual(loaded);
      expect(readJSONIfExists<SessionV1>(`${targetPath}.bak`)).toEqual(
        loadV1(),
      );
      // No higher rotation slots yet (no prior .bak existed).
      expect(fs.existsSync(`${targetPath}.bak.1`)).toBe(false);
      expect(fs.existsSync(`${targetPath}.bak.2`)).toBe(false);

      // premigrate.bak is untouched by rotation — it sits outside the
      // managed slot allowlist.
      expect(fs.existsSync(premigrate)).toBe(true);
      expect(JSON.parse(fs.readFileSync(premigrate, 'utf-8'))).toEqual(
        loadV1(),
      );
    },
  );

  it(
    'case A2: v1 primary + v1 .bak already on disk; load+migrate, then save ' +
      'with rotation → primary=v2, .bak=v1(previous primary), .bak.1=v1(previous .bak)',
    async () => {
      // Seed both slots with v1 payloads. Give them slightly different
      // workspaceIds so we can tell which one lands in which slot.
      const v1Primary: SessionV1 = {
        version: 1,
        workspaceId: 'ws-primary',
        panes: [{ id: 'p1', cwd: '/a' }],
      };
      const v1Bak: SessionV1 = {
        version: 1,
        workspaceId: 'ws-bak-legacy',
        panes: [{ id: 'p1', cwd: '/legacy' }],
      };
      fs.writeFileSync(targetPath, JSON.stringify(v1Primary), 'utf-8');
      fs.writeFileSync(`${targetPath}.bak`, JSON.stringify(v1Bak), 'utf-8');

      // Load the primary; migrator returns v2 and writes premigrate.bak.
      const loaded = await atomicReadJSON<SessionV2>(targetPath, {
        migrator: createMigrator<SessionV2>(V1_TO_V2, targetPath),
      });
      expect(loaded).toEqual({
        version: 2,
        workspaceId: 'ws-primary',
        panes: [{ id: 'p1', cwd: '/a', scrollbackLimit: 1000 }],
      });
      expect(fs.existsSync(premigratePathFor(targetPath, 1))).toBe(true);

      // Now the caller persists the migrated payload with rotation on.
      // Rotation walks oldest-first: .bak → .bak.1 happens BEFORE the
      // previous primary is moved to .bak. So:
      //   - .bak.1 should now contain what .bak held (v1Bak).
      //   - .bak should now contain what primary held (v1Primary).
      //   - primary should contain the freshly-written v2 payload.
      await atomicWriteJSON(targetPath, loaded, { rotationEnabled: true });

      expect(readJSONIfExists<SessionV2>(targetPath)).toEqual(loaded);
      expect(readJSONIfExists<SessionV1>(`${targetPath}.bak`)).toEqual(
        v1Primary,
      );
      expect(readJSONIfExists<SessionV1>(`${targetPath}.bak.1`)).toEqual(
        v1Bak,
      );
      expect(fs.existsSync(`${targetPath}.bak.2`)).toBe(false);
    },
  );
});

// ── Scenario B: Migration failure + corruption ───────────────────────

describe('T13-B: migration failure + corruption quarantine', () => {
  it(
    'case B1: migrator throws → atomicReadJSON returns null; primary file ' +
      'is NOT quarantined; premigrate.bak captures the pre-migration payload',
    async () => {
      // Seed v1. Use a migrator that writes the premigrate snapshot
      // (via createMigrator) and then throws on the step itself.
      fs.copyFileSync(V1_FIXTURE_PATH, targetPath);

      const explosiveRegistry: MigrationRegistry = {
        currentVersion: 2,
        steps: [
          {
            fromVersion: 1,
            toVersion: 2,
            migrate: () => {
              throw new Error('step exploded');
            },
          },
        ],
      };

      const stderr = captureStderr();
      let loaded: SessionV2 | null;
      try {
        loaded = await atomicReadJSON<SessionV2>(targetPath, {
          migrator: createMigrator<SessionV2>(explosiveRegistry, targetPath),
        });
      } finally {
        stderr.restore();
      }

      // Migrator throw is swallowed by atomicReadJSON (parse-level
      // failure semantics): primary attempt returns null and the
      // fallback walks .bak suffixes. None exist, so the final answer
      // is null.
      expect(loaded).toBeNull();

      // The primary file is untouched — a migrator throw does not
      // trigger the quarantine path (that is reserved for validate
      // rejection). The bytes on disk must still be the original v1.
      expect(fs.existsSync(targetPath)).toBe(true);
      expect(readJSONIfExists<SessionV1>(targetPath)).toEqual(loadV1());

      // No corrupted/ directory should have been created either.
      expect(fs.existsSync(corruptedDir)).toBe(false);

      // premigrate.bak is written *before* the step runs, so it must
      // exist and still carry the v1 payload even though the chain
      // subsequently failed.
      const premigrate = premigratePathFor(targetPath, 1);
      expect(fs.existsSync(premigrate)).toBe(true);
      expect(JSON.parse(fs.readFileSync(premigrate, 'utf-8'))).toEqual(
        loadV1(),
      );

      // No CORRUPT_FILE log line either — migrator failure is a
      // different code path from quarantine.
      const corruptLogs = stderr.lines.filter((l) =>
        l.includes('"CORRUPT_FILE"'),
      );
      expect(corruptLogs).toHaveLength(0);
    },
  );

  it(
    'case B2: v1 read → migrator succeeds → validate rejects migrated payload → ' +
      'primary is quarantined and premigrate.bak still preserves original v1',
    async () => {
      // The validate hook runs *after* the migrator in the read path
      // (see core.ts). So a successful migration that produces a
      // payload the validator rejects must route through the same
      // quarantine code as a straight validate failure.
      fs.copyFileSync(V1_FIXTURE_PATH, targetPath);

      // A validator that rejects everything — guarantees the migrated
      // payload (v2) triggers the quarantine branch.
      const rejectAll = (_d: unknown): _d is SessionV2 => false;

      const stderr = captureStderr();
      let loaded: SessionV2 | null;
      try {
        loaded = await atomicReadJSON<SessionV2>(targetPath, {
          migrator: createMigrator<SessionV2>(V1_TO_V2, targetPath),
          validate: rejectAll,
          clock: () => 1_700_000_500_000,
        });
      } finally {
        stderr.restore();
      }

      // Validate rejected the migrated payload — return null and the
      // fallback chain walks .bak suffixes (none exist) so final is null.
      expect(loaded).toBeNull();

      // Primary was moved into corrupted/ because the migrated payload
      // failed validate. The SOURCE of the quarantine is the on-disk
      // primary path (not the migrated in-memory payload), so the
      // quarantined file still carries the original v1 bytes.
      expect(fs.existsSync(targetPath)).toBe(false);
      const quarantined = path.join(
        corruptedDir,
        'session.json.1700000500000.bak',
      );
      expect(fs.existsSync(quarantined)).toBe(true);
      expect(JSON.parse(fs.readFileSync(quarantined, 'utf-8'))).toEqual(
        loadV1(),
      );

      // premigrate.bak remains exactly where createMigrator placed it
      // — it is not a rotation-managed slot, so quarantine must leave
      // it alone.
      const premigrate = premigratePathFor(targetPath, 1);
      expect(fs.existsSync(premigrate)).toBe(true);
      expect(JSON.parse(fs.readFileSync(premigrate, 'utf-8'))).toEqual(
        loadV1(),
      );

      // CORRUPT_FILE log emitted.
      const corruptLogs = stderr.lines.filter((l) =>
        l.includes('"CORRUPT_FILE"'),
      );
      expect(corruptLogs.length).toBeGreaterThanOrEqual(1);
    },
  );
});

// ── Scenario C: Rotation + corruption quarantine ─────────────────────

describe('T13-C: rotation + corruption quarantine', () => {
  it(
    'case C1: primary validate failure → quarantined → .bak.1 rescues read → ' +
      'next rotation write restores a clean chain',
    async () => {
      // Build out a three-generation rotation chain. After these three
      // writes:
      //   primary = g3, .bak = g2, .bak.1 = g1.
      await atomicWriteJSON(
        targetPath,
        { shape: 'good', gen: 1 },
        { rotationEnabled: true },
      );
      await atomicWriteJSON(
        targetPath,
        { shape: 'good', gen: 2 },
        { rotationEnabled: true },
      );
      await atomicWriteJSON(
        targetPath,
        { shape: 'good', gen: 3 },
        { rotationEnabled: true },
      );

      // Tamper primary AND .bak with payloads that parse as valid
      // JSON but fail validate. Fallback must skip both → land on
      // .bak.1 (gen 1).
      fs.writeFileSync(targetPath, JSON.stringify({ shape: 'bad' }), 'utf-8');
      fs.writeFileSync(
        `${targetPath}.bak`,
        JSON.stringify({ shape: 'also-bad' }),
        'utf-8',
      );

      type GoodShape = { shape: 'good'; gen: number };
      const goodShape = (d: unknown): d is GoodShape =>
        typeof d === 'object' &&
        d !== null &&
        (d as Record<string, unknown>)['shape'] === 'good';

      // Use a monotonic clock so the two quarantine filenames differ.
      let counter = 1_700_001_000_000;
      const clock = () => counter++;

      const stderr = captureStderr();
      let loaded: GoodShape | null;
      try {
        loaded = await atomicReadJSON<GoodShape>(targetPath, {
          validate: goodShape,
          clock,
        });
      } finally {
        stderr.restore();
      }

      // .bak.1 should have rescued us with gen 1.
      expect(loaded).toEqual({ shape: 'good', gen: 1 });

      // Primary + .bak both moved into corrupted/.
      expect(fs.existsSync(targetPath)).toBe(false);
      expect(fs.existsSync(`${targetPath}.bak`)).toBe(false);
      const quarantineNames = fs.readdirSync(corruptedDir).sort();
      expect(quarantineNames).toHaveLength(2);

      // .bak.1 survived — rotation chain is partially torn but
      // structurally intact from here down.
      expect(fs.existsSync(`${targetPath}.bak.1`)).toBe(true);

      // Now the caller saves a fresh payload with rotation on. The
      // write path walks oldest-first BEFORE touching the new .bak
      // slot:
      //   - primary is missing → primary→.bak rename is a no-op
      //     (ENOENT swallowed by best-effort branch).
      //   - rotateBackups: .bak.2→.bak.3 (no source, no-op),
      //                    .bak.1→.bak.2 (gen1 bytes move up),
      //                    .bak→.bak.1   (no source, no-op).
      //   - tmp → primary lands the new payload.
      await atomicWriteJSON(
        targetPath,
        { shape: 'good', gen: 4 },
        { rotationEnabled: true },
      );

      expect(readJSONIfExists<GoodShape>(targetPath)).toEqual({
        shape: 'good',
        gen: 4,
      });
      // The old gen1 bytes (from .bak.1) were promoted to .bak.2.
      expect(readJSONIfExists<GoodShape>(`${targetPath}.bak.2`)).toEqual({
        shape: 'good',
        gen: 1,
      });
      // corrupted/ is untouched by the subsequent rotation write.
      const quarantineAfter = fs.readdirSync(corruptedDir).sort();
      expect(quarantineAfter).toEqual(quarantineNames);
    },
  );

  it(
    'case C2: primary + .bak both quarantined → .bak.1 rescues → corrupted/ ' +
      'keeps 2 files and subsequent rotation writes never touch them',
    async () => {
      // Build a four-generation chain: primary=g4, .bak=g3, .bak.1=g2,
      // .bak.2=g1.
      for (let i = 1; i <= 4; i++) {
        await atomicWriteJSON(
          targetPath,
          { shape: 'good', gen: i },
          { rotationEnabled: true },
        );
      }

      // Corrupt primary + .bak. .bak.1 (gen2) stays healthy.
      fs.writeFileSync(targetPath, JSON.stringify({ shape: 'bad' }), 'utf-8');
      fs.writeFileSync(
        `${targetPath}.bak`,
        JSON.stringify({ shape: 'bad' }),
        'utf-8',
      );

      type GoodShape = { shape: 'good'; gen: number };
      const goodShape = (d: unknown): d is GoodShape =>
        typeof d === 'object' &&
        d !== null &&
        (d as Record<string, unknown>)['shape'] === 'good';

      let counter = 1_700_002_000_000;
      const clock = () => counter++;

      const stderr = captureStderr();
      let loaded: GoodShape | null;
      try {
        loaded = await atomicReadJSON<GoodShape>(targetPath, {
          validate: goodShape,
          clock,
        });
      } finally {
        stderr.restore();
      }

      // Recovered from .bak.1.
      expect(loaded).toEqual({ shape: 'good', gen: 2 });

      // Exactly two files in corrupted/ (primary + .bak origin).
      const corruptedSnapshot = fs.readdirSync(corruptedDir).sort();
      expect(corruptedSnapshot).toHaveLength(2);
      // One name descends from the primary basename, the other from
      // the .bak slot — the timestamp suffix distinguishes them.
      const fromPrimary = corruptedSnapshot.filter(
        (n) => n.startsWith('session.json.') && !n.startsWith('session.json.bak'),
      );
      const fromBak = corruptedSnapshot.filter((n) =>
        n.startsWith('session.json.bak.'),
      );
      expect(fromPrimary).toHaveLength(1);
      expect(fromBak).toHaveLength(1);

      // Capture bytes so we can assert they're untouched later.
      const bytesByName = new Map(
        corruptedSnapshot.map((n) => [
          n,
          fs.readFileSync(path.join(corruptedDir, n), 'utf-8'),
        ]),
      );

      // Drive two more rotation writes. If any of them reached into
      // corrupted/ the byte snapshot or the file list would change.
      await atomicWriteJSON(
        targetPath,
        { shape: 'good', gen: 5 },
        { rotationEnabled: true },
      );
      await atomicWriteJSON(
        targetPath,
        { shape: 'good', gen: 6 },
        { rotationEnabled: true },
      );

      const corruptedAfter = fs.readdirSync(corruptedDir).sort();
      expect(corruptedAfter).toEqual(corruptedSnapshot);
      for (const name of corruptedAfter) {
        expect(
          fs.readFileSync(path.join(corruptedDir, name), 'utf-8'),
        ).toBe(bytesByName.get(name));
      }
    },
  );
});

// ── Scenario D: full combination ─────────────────────────────────────

describe('T13-D: migration + rotation + corruption combined', () => {
  it(
    'case D1: v1 primary fails validate → quarantined; v1 .bak rescues; ' +
      'migrator upgrades to v2 and writes premigrate.bak',
    async () => {
      // Primary = v1 shape but payload fails validate.
      // .bak = pristine v1 fixture.
      //
      // Flow under test:
      //   1. attempt(primary) reads → parses → migrator runs → validate
      //      receives migrated v2. Validator rejects (it only accepts
      //      primary ws=ws-good). Quarantine primary. Return null.
      //   2. fallback walks `.bak` → parses v1 → migrator runs →
      //      produces v2 → validator accepts. Return v2.
      //   3. premigrate.bak is pinned to the FIRST invocation of the
      //      migrator (the primary path), so it reflects the primary
      //      bytes, not the .bak bytes.
      const v1Primary: SessionV1 = {
        version: 1,
        workspaceId: 'ws-PRIMARY-BAD',
        panes: [{ id: 'p1', cwd: '/a' }],
      };
      const v1Bak: SessionV1 = {
        version: 1,
        workspaceId: 'ws-good',
        panes: [{ id: 'p1', cwd: '/good' }],
      };
      fs.writeFileSync(targetPath, JSON.stringify(v1Primary), 'utf-8');
      fs.writeFileSync(`${targetPath}.bak`, JSON.stringify(v1Bak), 'utf-8');

      // Validator: only accept the migrated payload originating from
      // the .bak slot.
      const validateGood = (d: unknown): d is SessionV2 =>
        isV2(d) &&
        (d as SessionV2).workspaceId === 'ws-good';

      const stderr = captureStderr();
      let loaded: SessionV2 | null;
      try {
        loaded = await atomicReadJSON<SessionV2>(targetPath, {
          migrator: createMigrator<SessionV2>(V1_TO_V2, targetPath),
          validate: validateGood,
          clock: () => 1_700_003_000_000,
        });
      } finally {
        stderr.restore();
      }

      // .bak rescued the read; returned payload is v2 from ws-good.
      expect(loaded).toEqual({
        version: 2,
        workspaceId: 'ws-good',
        panes: [{ id: 'p1', cwd: '/good', scrollbackLimit: 1000 }],
      });

      // Primary was quarantined — original v1Primary bytes sit in
      // corrupted/ under the deterministic clock filename.
      expect(fs.existsSync(targetPath)).toBe(false);
      const quarantined = path.join(
        corruptedDir,
        'session.json.1700003000000.bak',
      );
      expect(fs.existsSync(quarantined)).toBe(true);
      expect(JSON.parse(fs.readFileSync(quarantined, 'utf-8'))).toEqual(
        v1Primary,
      );

      // .bak is still in place (it was the rescue slot; no validate
      // failure there).
      expect(fs.existsSync(`${targetPath}.bak`)).toBe(true);
      expect(readJSONIfExists<SessionV1>(`${targetPath}.bak`)).toEqual(v1Bak);

      // premigrate.bak exists and pins to the FIRST migrator
      // invocation — i.e. the primary payload that was quarantined.
      // This lets operators recover the original pre-migration bytes
      // even after the primary slot has been moved to corrupted/.
      const premigrate = premigratePathFor(targetPath, 1);
      expect(fs.existsSync(premigrate)).toBe(true);
      expect(JSON.parse(fs.readFileSync(premigrate, 'utf-8'))).toEqual(
        v1Primary,
      );
    },
  );

  it(
    'case D2: files pre-seeded in corrupted/ are never re-loaded by ' +
      'atomicReadJSON, even when primary and managed backups are missing',
    async () => {
      // Seed corrupted/ with a file whose basename looks like a
      // rotation slot. If the fallback walk were naively globbing it
      // would accidentally scoop this up; it must not.
      fs.mkdirSync(corruptedDir, { recursive: true });
      const stashed = path.join(corruptedDir, 'session.json.bak');
      fs.writeFileSync(
        stashed,
        JSON.stringify({ shape: 'quarantined-payload' }),
        'utf-8',
      );
      // And a timestamp-suffixed quarantine copy for good measure.
      const quarantined = path.join(
        corruptedDir,
        'session.json.1700004000000.bak',
      );
      fs.writeFileSync(
        quarantined,
        JSON.stringify({ shape: 'quarantined-copy' }),
        'utf-8',
      );

      // No primary, no managed backups at the real target path.
      expect(fs.existsSync(targetPath)).toBe(false);
      expect(fs.existsSync(`${targetPath}.bak`)).toBe(false);

      const stderr = captureStderr();
      let loaded: unknown;
      try {
        loaded = await atomicReadJSON(targetPath);
      } finally {
        stderr.restore();
      }

      // corrupted/ must never participate in the fallback walk. With
      // no managed slots available the answer is null.
      expect(loaded).toBeNull();

      // corrupted/ subtree is byte-identical to what we seeded —
      // neither file was renamed, re-quarantined, or cleaned up by
      // the read path.
      const after = fs.readdirSync(corruptedDir).sort();
      expect(after).toEqual(
        ['session.json.1700004000000.bak', 'session.json.bak'].sort(),
      );
      expect(fs.readFileSync(stashed, 'utf-8')).toBe(
        JSON.stringify({ shape: 'quarantined-payload' }),
      );
      expect(fs.readFileSync(quarantined, 'utf-8')).toBe(
        JSON.stringify({ shape: 'quarantined-copy' }),
      );

      // Seed a healthy primary so a subsequent read confirms the
      // quarantined file is still ignored even once the fallback
      // chain would otherwise have a shorter walk.
      await atomicWriteJSON(targetPath, { shape: 'healthy' });
      const secondRead = await atomicReadJSON<{ shape: string }>(targetPath);
      expect(secondRead).toEqual({ shape: 'healthy' });

      // Still no corrupted/ disturbance.
      const finalSnapshot = fs.readdirSync(corruptedDir).sort();
      expect(finalSnapshot).toEqual(after);
    },
  );
});
