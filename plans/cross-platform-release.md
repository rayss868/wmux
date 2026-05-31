# Cross-Platform Release Plan (macOS + Linux)

Status: DRAFT — awaiting user confirmation before implementation
Date: 2026-05-31
Base: main @ v2.16.0
Decision inputs: user (macOS + Linux simultaneously, plan-first), Apple Developer account available.
Validation: multi-agent workflow `xplat-understand-design` (9 agents) — 5-area map + 2 design
decisions, each adversarially reviewed by a skeptic agent (both verdicts: "risky" with concrete
fixes, folded into this plan). Cross-checked against direct reads of AutoUpdater.ts,
verifyUpdate.ts, forge.config.ts, release.yml, ci-cross-platform-baseline.yml, install.ps1,
package.json.

---

## 0. Headline decisions

1. **Single repo.** wmux is Electron 41 + node-pty. Keep one codebase; branch builds per-OS.
   Splitting the repo buys nothing and creates 3-way fork drift. The repo is ALREADY built for
   this: `src/shared/platform.ts` (`platformChoice<T>`), `forge.config.ts` per-OS maker guards,
   3-OS CI baseline. The only thing that should live in its own repo is the future Homebrew tap.

2. **Auto-updater = Option C** (extend the existing custom updater; do NOT migrate to
   electron-updater or a hosted feed). The electron `autoUpdater` import is dead code; the real
   flow is a custom SHA-256-pinned `net.request` + `shell.openPath` pipeline that is already
   platform-portable. Add a `darwin` branch (ZIP self-update, after signing); **Linux has NO
   in-app auto-update in v1 — no check, no notification** (user-decided). Linux users update via
   their package manager (apt/dnf) or by re-downloading the AppImage. AutoUpdater is fully inert
   on Linux.

3. **Release pipeline = per-OS jobs, but Windows ALWAYS ships.** Reject any `needs:[win,mac,linux]`
   hard gate. macOS/Linux build legs are opt-in (`vars.ENABLE_CROSS_PLATFORM_RELEASE`) and
   best-effort; a macOS/Linux build failure must never block the Windows release.

4. **Integrity pin is non-negotiable.** The NN2-T4 SHA-256 manifest pin (verifyUpdate.ts) stays on
   every platform path. This is why Option B (hosted feed, can't carry a hash) is rejected.

5. **macOS signing is the real critical path** and gates the in-app macOS updater. Until Apple
   creds + notarization + hardened-runtime entitlements are green, the darwin updater stays
   notify-only (same as Linux).

---

## 1. Confirmed current state (from map + direct reads)

### Auto-updater (`src/main/updater/`)
- `AutoUpdater.ts:20` — `UPDATE_SERVER` hardcodes `update.electronjs.org/<repo>/win32/<ver>`.
- `AutoUpdater.ts:170` — temp installer name hardcodes `.Setup.exe`.
- `AutoUpdater.ts:257` — install = `shell.openPath(tempPath)` (cross-platform call, win-shaped arg).
- `AutoUpdater.ts:11` — electron `autoUpdater` is imported but **never called** (dead). The custom
  net.request flow exists because Squirrel's .NET updater is broken vs GitHub 302/TLS (documented
  AutoUpdater.ts:7-8). DO NOT wire electron autoUpdater in.
- `verifyUpdate.ts` — pure, fail-closed, unit-tested. `UpdateManifest = {version,setupExe,sha256,url}`
  (Windows-shaped field names). `isAllowedDownloadUrl` = github.com only (DMG/ZIP are GH assets too,
  so no allowlist change needed).
- `AutoUpdater` has **zero** `process.platform` branching and **zero** platform mock tests today.
- Consumers of `update-manifest.json`: in-app AutoUpdater AND `install.ps1:228-232` (reads
  top-level `.sha256`; graceful-skips if absent). Chocolatey uses its own injected checksum (safe).

### CI / Release
- `release.yml` — single `runs-on: windows-latest` job: Build&Make → SignPath (env-gated no-op) →
  checksum → write `update-manifest.json` → GitHub Release → Choco → winget. 100% PowerShell.
- `ci.yml` — windows-only PR gate (tsc/test/lint, no build).
- `ci-cross-platform-baseline.yml` — 3-OS matrix (windows-latest, macos-14, ubuntu-22.04), runs
  `npm ci` + tsc + eslint + **full vitest**, but **NOT `npm run make`** → packaging is unverified
  on mac/linux. Informational, fail-fast:false, NOT a release gate. Linux installs build-essential
  + libxss1; macOS verifies Xcode CLT.

### Build / packaging (`forge.config.ts`, `package.json`)
- Makers per-OS guarded: win→Squirrel, darwin→`MakerZIP(['darwin'])` ONLY, linux→Deb+Rpm.
- `package.json` has maker-squirrel/zip/deb/rpm; **missing `@electron-forge/maker-dmg`,
  `@electron/notarize`, any AppImage maker.**
- `packagerConfig` has **no** `osxSign`/`osxNotarize`. No entitlements plist anywhere.
- `postPackage` hook (46-111) runs unconditionally: extracts+repacks asar to inject node-pty
  (changes asar hash); `.ps1` cleanup is win32-guarded.
- Fuses: `RunAsNode=true` (daemon spawns via `ELECTRON_RUN_AS_NODE=1`),
  `EnableEmbeddedAsarIntegrityValidation=false` (because repack changes the hash),
  `OnlyLoadAppFromAsar=true`.
- Icons: `assets/icon.{ico,icns,png,svg}` all present; `createWindow.ts` already uses
  `platformChoice` for the icon extension.
- Electron 41.0.3 → SMAppService available (Phase 1.7 autostart research conclusion holds).

### Phase 1 code residuals (Unix correctness gaps)
- **No `autostart.ts`** / no `app.setLoginItemSettings`. Windows uses registry (index.ts:99-121);
  macOS (LaunchAgent / `setLoginItemSettings`) + Linux (`~/.config/autostart/*.desktop`) absent.
- **PTY spawn has no try/catch**: `DaemonSessionManager.ts:139`, `PTYManager.ts:155` call
  `pty.spawn()` raw. `MACOS_ERRORS.nodePtyBuildFailed` is defined but never surfaced.
- `src/shared/errors/macos.ts` — 5 templates; only `mcpPermissionDenied` is wired (McpRegistrar.ts).
  `gatekeeperBlocked`, `nodePtyBuildFailed`, `brewTapNotFound`, `playwrightChromiumQuarantine`
  defined but never thrown.
- **Shell integration**: `shell-integration.ts` integrates pwsh + bash only; zsh/fish marked "v3
  roadmap". `PTYManager.detectShellType()` returns 'unknown' for zsh/fish. → macOS default zsh
  users get NO OSC 133 prompt markers (agent.lifecycle / awaiting_input degraded on macOS).
- `metadata.handler.ts:58` — `/proc/PID/cwd` is Linux-only; macOS has no live-CWD fallback.
- `PTYManager.getDefaultShell()` trusts `$SHELL` without bash-path resolution (DaemonSessionManager
  does resolve). `claudeCredential.ts` handles darwin Keychain / win / linux-JSON (documented; Linux
  has no libsecret — acceptable).

### Tests
- 164 test files; baseline runs full vitest on 3 OSes. Most platform logic uses `vi` platform mocks
  (ShellDetector/ToastManager are exemplars) → cross-platform safe.
- **CORRECTION (verified 2026-05-31):** the 3-OS `ci-cross-platform-baseline` is ALREADY GREEN —
  last 5 runs on main + feature branches all `success`. The map agent's "pwshHook.test.ts will
  ENOENT-fail on mac/linux" was WRONG: `src/main/pty/shell-hooks/pwsh.ps1` is a checked-in source
  file present after checkout on every OS, and vitest runs from repo root, so the test PASSES
  cross-platform. The CI header's "first runs expected to fail (45 win32 branches)" is stale — those
  unix branches now pass tsc+eslint+vitest. ⇒ **A3 skip guard is NOT needed.** Only `npm run make`
  (packaging) and runtime remain unverified on mac/linux.

---

## 2. Design decision 1 — Auto-updater cross-platform path

**Chosen: Option C** — extend the existing custom updater behind a `platformChoice` seam.
Win32 arm stays byte-for-byte identical. macOS adds a `darwin` branch. Linux = notify-only v1.

Rejected: A (electron-updater/NSIS — max blast radius on the only shipping platform, drops the SHA
pin, breaks Squirrel/Choco/winget/SignPath). B (hosted feed — can't carry the hash field, regresses
the NN2-T4 supply-chain pin, risks resurrecting the broken Squirrel-on-GitHub updater on Windows).

### Skeptic-mandated corrections (folded in)
- **C-FIX-1 (feed semantics):** `update.electronjs.org/darwin/` only recognizes a **`.zip`** asset
  named `*-mac/-darwin/-osx` — it does NOT serve `.dmg`. So: treat the `/darwin/` feed as a
  **version-discovery ping** backed by a published `-mac.zip` (keep `MakerZIP`, ADD `MakerDMG` — do
  not replace). The integrity-pinned self-update artifact is the **ZIP** (electron-idiomatic: the
  app bundle drops straight into /Applications and supports relaunch). DMG is for first-install
  download UX only. Do NOT describe the feed as "serving the DMG".
- **C-FIX-2 (relaunch semantics):** DMG mount does not install or relaunch. The ZIP self-update path
  must define relaunch behavior; the `beforeunload`/session-save dance (AutoUpdater.ts:225-240)
  assumes installer-replaces-then-relaunches and is wrong for a bare mount — guard/skip it on darwin
  for the v1 notify-only stage.
- **C-FIX-3 (entitlements):** `RunAsNode=true` + notarization REQUIRES hardened runtime with
  entitlements (`com.apple.security.cs.allow-jit`,
  `com.apple.security.cs.allow-unsigned-executable-memory`,
  `com.apple.security.cs.disable-library-validation` as needed for `ELECTRON_RUN_AS_NODE` daemon
  spawn). Without the entitlements plist a notarized build will fail to spawn the daemon at runtime.
  This is a hard prerequisite, not optional.
- **C-FIX-4 (manifest back-compat):** evolving the manifest to a per-platform map MUST keep the
  legacy top-level `{version,setupExe,sha256,url}` as a win32 alias for ≥1 release, because BOTH
  older in-app clients AND `install.ps1:232` read top-level `.sha256`. Update install.ps1 in
  lockstep + add a release-time assertion that the manifest parses under both readers.
- **C-FIX-5 (TDD first):** AutoUpdater has no platform tests. Write the `process.platform` mock test
  asserting win32 resolves the byte-identical URL+filename BEFORE introducing `platformChoice`.

### Manifest schema (target, additive)
```jsonc
{
  "version": "x.y.z",
  // legacy win32 alias — keep for ≥1 release (in-app old clients + install.ps1)
  "setupExe": "wmux-x.y.z.Setup.exe",
  "sha256": "<win32 setup.exe sha256>",
  "url": "https://github.com/.../wmux-x.y.z.Setup.exe",
  "platforms": {
    "win32":  { "file": "...Setup.exe", "sha256": "...", "url": "..." },
    "darwin": { "file": "wmux-x.y.z-mac.zip", "sha256": "...", "url": "..." }
    // no linux entry — notify-only, package-manager-owned
  }
}
```

---

## 3. Design decision 2 — release.yml restructure

**Chosen: per-OS jobs, Windows self-contained + always-ships.** NOT a hard coordinator gate.

### Skeptic-mandated corrections (folded in)
- **R-FIX-1 (no hard gate — FATAL otherwise):** Keep the GitHub Release **created inside the
  `windows` job** exactly as today. macOS/Linux jobs **append** their assets via
  `gh release upload v$VERSION <files> --clobber` with `continue-on-error: true`. Windows ships even
  if cross-platform builds fail. (Alternative: a coordinator `needs:[windows]` only — but
  append-from-each-OS keeps the Windows job a byte-for-byte superset of today, lowest risk.)
- **R-FIX-2 (opt-in flag):** `macos`/`linux` jobs run only `if: vars.ENABLE_CROSS_PLATFORM_RELEASE
  == 'true'`. Until flipped, tag push behaves exactly like today (Windows-only). Mirrors the
  SignPath/CHOCO/WINGET no-op-when-empty pattern.
- **R-FIX-3 (sequencing):** Land forge maker plumbing (§4 Phase B/C) and prove `npm run make` emits
  darwin/linux artifacts on a throwaway fork tag BEFORE flipping the flag. Use
  `if-no-files-found: warn` (not `error`) on mac/linux uploads during transition.
- **R-FIX-4 (winget ordering):** winget-releaser reads the GH Release by version. Since it must run
  AFTER the release exists and the Windows job creates the release, winget stays in the `windows`
  job AFTER the create-release step (unchanged from today). `choco push` → push.chocolatey.org (no
  release dependency) stays in `windows`.
- **R-FIX-5 (updater correctness on multi-OS release — do FIRST, see Phase A):** A Windows-only
  manifest on a release that now carries mac/linux assets makes a macOS client download+launch a
  `.Setup.exe`. Ship the AutoUpdater `process.platform !== 'win32'` early-return (Phase A) BEFORE
  any mac/linux asset reaches a release.
- **R-FIX-6 (notarization latency/flake):** osxNotarize calls Apple's notary service synchronously
  inside `npm run make`; set a generous job timeout and treat notary failure as `continue-on-error`
  on the macOS leg so an Apple outage can't block the (decoupled) Windows release.

### Job shape
```
job windows  (runs-on: windows-latest)  — TODAY's job, UNCHANGED (incl. Create Release, Choco, winget)
job macos    (if ENABLE; matrix: macos-14 arm64, macos-13 x64) — make, keychain import (env-gated),
             sign+notarize (env-gated), then `gh release upload --clobber` (continue-on-error)
job linux    (if ENABLE; ubuntu-22.04) — apt deps (+rpm,fakeroot), make, `gh release upload` (c-o-e)
```

---

## 4. Implementation phases & PR sequence

Ordering is dependency-driven. **Branch + PR per phase** (cross-platform branch policy: feature
branch, CI green before main, avoid main-fail mail noise).

### Phase A — Updater safety guards (Windows-only risk: ZERO) — **PR1**
- A1. `AutoUpdater`: introduce `isUpdaterSupported = process.platform === 'win32'` (darwin added in
  Phase E once signed). On non-win32: register IPC handlers for UI consistency but DO NOT schedule
  the auto-check timer, `UPDATE_CHECK` returns `not-available`, `UPDATE_INSTALL` is a no-op (log
  only). Guarantees macOS/Linux clients NEVER download/launch a `.Setup.exe` even once multi-OS
  assets land on the release. win32 path is byte-identical (flag is true → existing flow). (R-FIX-5)
  Linux stays fully inert permanently (user decision); darwin flips on in Phase E.
- A2. Add `AutoUpdater` platform mock test (electron mocked, vi platform mock à la ToastManager):
  win32 → timer scheduled + check runs + UPDATE_SERVER is byte-identical
  `update.electronjs.org/<repo>/win32/<ver>`; darwin/linux → no timer, check=not-available,
  install=no-op. (C-FIX-5 — TDD invariant before the Phase E platformChoice refactor.)
- ~~A3. pwshHook.test.ts skip guard~~ — DROPPED. Verified 2026-05-31: baseline is already green;
  pwsh.ps1 is checked in and the test passes on all OSes. No fix needed.
- Net: hardens Windows (no behavior change on win32). Shippable alone. The 3-OS suite is already
  green, so this only ADDS the new AutoUpdater platform test.

### Phase B — macOS build/sign plumbing (forge) — **PR2**
- B1. devDeps: `@electron-forge/maker-dmg`, `@electron/notarize`.
- B2. `forge.config.ts` darwin arm: keep `MakerZIP(['darwin'])` (feed + self-update artifact), ADD
  `MakerDMG` (first-install UX). (C-FIX-1)
- B3. `packagerConfig.osxSign` + `osxNotarize`, both built only when `process.env.APPLE_TEAM_ID` /
  `APPLE_ID` present (no-op otherwise — unsigned local builds still work).
- B4. **`build/entitlements.mac.plist`** with hardened-runtime + RunAsNode entitlements; wire into
  osxSign. (C-FIX-3) ← do not skip.
- B5. Verify signing runs AFTER postPackage asar repack (Forge package phase is post-postPackage →
  correct; assert, don't enable asar integrity).
- Verify on a fork throwaway tag before relying on it.

### Phase C — Linux build plumbing — **PR3**
- C1. AppImage: evaluate `@reforged/maker-appimage` (no official Forge AppImage maker). If included,
  add maker; else deb/rpm only for v1 (acceptable).
- C2. Linux release deps: `rpm`, `fakeroot` (rpm maker needs them) on top of build-essential+libxss1.
- Verify `npm run make` emits .deb/.rpm(/.AppImage) on ubuntu fork tag.

### Phase D — release.yml restructure (HIGH CARE) — **PR4**
- D1. Keep `windows` job byte-for-byte (incl. Create Release, Choco, winget). Add job-level Apple
  secret env block (no-op when empty).
- D2. Add `macos` job (2-arch matrix, env-gated keychain import + sign/notarize, `gh release upload
  --clobber` continue-on-error, `if: always()` keychain cleanup, `if: vars.ENABLE_...`). (R-FIX-1/2/6)
- D3. Add `linux` job (apt deps, make, upload append). (R-FIX-1/2)
- D4. Per-platform manifest: extend the Windows "Write update manifest" step to emit `platforms.win32`
  + keep top-level alias; merge darwin zip sha256 (computed in macos job, passed as job output) only
  once macOS signing is green. Until then manifest stays win32-only. (C-FIX-4)
- D5. Add `ci-cross-platform-baseline` `npm run make` smoke on macos-14 + ubuntu (make it a gate for
  updater/forge files). (closes the "packaging unverified" gap)

### Phase E — macOS in-app updater darwin branch (AFTER signing green) — **PR5**
- E1. Evolve `verifyUpdate.UpdateManifest` to per-platform map + `validateManifestForPlatform`,
  keep legacy top-level alias + tests. Update `install.ps1` lockstep. (C-FIX-4)
- E2. `AutoUpdater` UPDATE_SERVER / temp filename via `platformChoice` (win32 arm byte-identical,
  enforced by A2 test).
- E3. darwin self-update = download+pin the **ZIP**, replace app bundle, define relaunch; DMG is
  download-only. Guard the beforeunload/session-save flow appropriately. (C-FIX-1/2)
- E4. Wire `MACOS_ERRORS.gatekeeperBlocked` into the darwin install-failure catch.
- Flip darwin from notify-only → real self-update only when notarized build + daemon-spawn smoke pass.

### Phase F — Phase 1 code completeness (parallelizable) — **PR6+**
- F1. PTY spawn try/catch → surface `nodePtyBuildFailed` (DaemonSessionManager.ts:139,
  PTYManager.ts:155). Keep error handling daemon-local (don't make process.on('error') global).
- F2. Wire remaining `macos.ts` errors at their catch sites.
- F3. **zsh shell integration** (macOS default) — OSC 133 markers for zsh; extend
  `detectShellType` + `buildHookInjection` + `shell-integration.ts`. Higher value than autostart;
  own batch (touches the OSC 133 handshake — reuse the SampleTaskRunner mangle-guard learnings).
- F4. `autostart.ts`: `app.setLoginItemSettings({openAtLogin})` (mac) + `~/.config/autostart/
  wmux.desktop` (linux); keep Windows registry path guarded.
- F5. `metadata.handler` macOS live-CWD fallback (no /proc on macOS).

### Phase G — docs/marketing drift — **PRn**
- README/package.json description say "cmux for Windows" / keyword "windows" — update at macOS GA.
- Add docs/MACOS.md + docs/LINUX.md (Phase 2/3 backlog from the 16-week plan).

### User-provided (out of band, blocks Phase D macOS leg going live)
- GitHub repo secrets: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`,
  `APPLE_CERT_P12_BASE64`, `APPLE_CERT_PASSWORD`, `KEYCHAIN_PASSWORD`.
- Decide AppImage in/out for v1.
- (Later) Homebrew tap repo + PAT for `brew install`.

---

## 5. Windows regression invariants (must hold across every PR)
1. `AutoUpdater` win32 UPDATE_SERVER == `https://update.electronjs.org/openwong2kim/wmux/win32/<ver>`
   character-identical (A2 test enforces).
2. win32 temp installer name stays `wmux-update-<ver>-<pid>.Setup.exe`.
3. `verifyUpdate.validateManifest` keeps accepting the legacy top-level shape (install.ps1 + old
   clients) for ≥1 release.
4. `windows` release job byte-for-byte: Build&Make, SignPath env-gating (release.yml:12-21,42,50,63),
   checksum AFTER signed-replace, manifest, Choco, winget regex `\.Setup\.exe$`. No matrix
   conditionals inside it.
5. `forge.config.ts`: SQUIRREL_SETUP_EXE name, win32 `.ps1` cleanup guard, asar repack, Fuses
   (RunAsNode true, asar-integrity false) all unchanged. maker-dmg additive only.
6. `index.ts:84-146` Squirrel events + HKCU Run registry remain reachable, unchanged; mac/linux
   autostart is additive behind its own guard.
7. Choco/winget stay `continue-on-error` — never fail the release.
8. Manual Windows lifecycle re-test before any updater/release merge: install (shortcuts + Run key)
   → in-app update (win32 feed → manifest → SHA match → openPath → relaunch) → uninstall.

## 6. Verification strategy
- Unit: AutoUpdater platform mock (A2), manifest dual-reader (E1), per-platform validate.
- CI: 3-OS baseline + `npm run make` smoke (D5) as a gate for forge/updater files.
- Dynamic: fork throwaway tag to exercise the macos/linux release legs before flipping
  `ENABLE_CROSS_PLATFORM_RELEASE` (no main-fail mail noise).
- macOS runtime smoke: notarized build must spawn the daemon (proves entitlements correct) before
  darwin updater goes from notify-only → real.
- User dogfood gate before any ship (no PR/release proposal until user verifies).

## 7. Open questions for the user
- AppImage for Linux v1, or deb/rpm only?
- macOS distribution: DMG (drag-to-Applications) as the primary download + ZIP for self-update, or
  ZIP only?
- Linux auto-update philosophy v1: notify-only + "copy this apt/dnf command" — confirmed acceptable?
