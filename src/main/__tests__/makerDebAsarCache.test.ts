import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Source-level WIRING invariants for the maker-deb / maker-rpm ".deb JSON parse"
// fix (issue #159).
//
// @electron/asar memoizes parsed archive headers in a module-level
// `filesystemCache` keyed by archive path. The postPackage hook in forge.config.ts
//   1. `asar.extractAll(asarPath, …)`   -> caches the ORIGINAL header for asarPath
//   2. …copies node-pty in…
//   3. `asar.createPackageWithOptions(…, asarPath, …)` -> rewrites the file on disk
//      but does NOT refresh the cache, so the cached offsets are now stale.
// `electron-forge make` runs packaging and the makers in ONE process sharing the
// same hoisted @electron/asar instance. On Linux the maker-deb / maker-rpm chain
// (electron-installer-common's readMetadata) then calls
// `asar.extractFile(asarPath, 'package.json')`, reads at the stale offset, lands
// inside bundled JS, and feeds non-JSON bytes to JSON.parse ->
// "Unexpected token … is not valid JSON". Windows (Squirrel) and macOS (DMG/ZIP)
// makers never read app.asar this way, so the break was Linux-only.
//
// The fix is `asar.uncache(asarPath)` AFTER the repack. forge.config.ts can't be
// imported and exercised in a unit test (postPackage needs a real packaged app
// tree on disk), so we pin the wiring over its source text — the repo's
// established source-invariant pattern (see squirrelWiring.test.ts). The dynamic
// FAIL->OK proof lives in the reproduction run captured on the PR.

describe('maker-deb fix — forge.config.ts postPackage asar-cache invariants', () => {
  const forgeConfigPath = path.join(__dirname, '..', '..', '..', 'forge.config.ts');
  const src = fs.readFileSync(forgeConfigPath, 'utf-8');

  it('drops the @electron/asar header cache for the repacked archive', () => {
    // The fix itself: the stale cache entry for the rewritten app.asar must be
    // evicted. Accept the precise path-scoped form or a whole-cache flush.
    const uncachesArchive = /asar\.uncache\(\s*asarPath\s*\)/.test(src);
    const uncachesAll = /asar\.uncacheAll\(\s*\)/.test(src);
    expect(uncachesArchive || uncachesAll).toBe(true);
  });

  it('evicts the cache AFTER the in-place repack, not before (else it is a no-op)', () => {
    // Uncaching before createPackageWithOptions rewrites the file would re-cache
    // nothing useful; the eviction only defeats staleness if it runs after the
    // repack that introduced it.
    const repackPos = src.search(/asar\.createPackageWithOptions\(\s*tempDir\s*,\s*asarPath/);
    const uncachePos = src.search(/asar\.uncache(All)?\(/);
    expect(repackPos).toBeGreaterThan(-1);
    expect(uncachePos).toBeGreaterThan(repackPos);
  });

  it('still extracts then repacks the SAME archive path (the scenario that staled the cache)', () => {
    // Anchors WHY the eviction is required: a read of asarPath (extractAll)
    // followed by an in-place rewrite of the same asarPath. If this stops being
    // true the invariant above is moot, but pinning it documents the hazard.
    const extractPos = src.search(/asar\.extractAll\(\s*asarPath/);
    const repackPos = src.search(/asar\.createPackageWithOptions\(\s*tempDir\s*,\s*asarPath/);
    expect(extractPos).toBeGreaterThan(-1);
    expect(repackPos).toBeGreaterThan(extractPos);
  });
});
