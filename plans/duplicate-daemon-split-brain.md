# Plan: Duplicate-daemon / split-brain on "Quit (keep sessions)" → relaunch (P1)

## Status
Design / plan-level. **No code changed.** High-risk daemon-lifecycle area
(issue #54 required 5 rounds of codex hardening). This doc grounds the fix in
the real code so a future session can implement it behind iterative codex
review. Folds in the P3 "cross-platform liveness/probe generalization" audit
(TODOS.md) — same root cause, same files.

## Symptom
"Quit (keep sessions running)" leaves the daemon + its PTYs alive. On the next
`npm start` / relaunch the terminal comes up **reset** (fresh sessions), and a
**second daemon** is running. Persistence (the headline feature) is broken and
RAM is wasted on the orphaned first daemon.

## Root cause — a three-defect chain (all code-confirmed)

Relaunch path is `ensureDaemon()` (`src/main/daemon/launcher.ts:352`). On a
slow / loaded machine (the exact condition PR #87 fixed for ProcessMonitor) the
chain is:

### Defect 1 — `isProcessAlive` coerces a probe TIMEOUT to "dead"
`launcher.ts:64-77`. On Windows it runs `tasklist.exe … { timeout: 3000 }` and
`catch { return false; }`. If `tasklist` is slow (Defender realtime scan, CPU
contention, WMI/Win32 pressure) it **throws on timeout → returns `false` →
"process absent"** even though the daemon is alive. This is the **identical
anti-pattern** PR #87 (commit c36b62b) removed from `ProcessMonitor`
(`isDefinitelyDead` positive-confirmation gate). A `false` here makes
`ensureDaemon` skip the ping/reuse branch entirely (the `if (existingPid &&
isProcessAlive(existingPid))` guard at line 364 is false) → straight to "clean
stale files + spawn".

### Defect 2 — `pingDaemon` double-timeout also reads as "absent"
`launcher.ts:186` (`timeout 3000 → resolve(false)`), called two-shot with a
250 ms gap (lines 376-380). The two-shot retry is good, but on a genuinely slow
box both shots can time out while the daemon is alive-but-busy. The fall-through
then enters the **kill-verify gate** (lines 387-438): if the PID is image-verified
as a wmux daemon (category a) it **SIGKILLs the live daemon and spawns** — which
**destroys the very sessions the user chose to keep**. (Category c — unverifiable
live — correctly throws; that path is already safe.)

### Defect 3 — `DaemonPipeServer` `-N` fallback can't tell a LIVE owner from a zombie
`src/daemon/DaemonPipeServer.ts:108-145`. When the freshly-spawned second daemon
tries to `listen` on the canonical pipe and gets `EADDRINUSE`, `tryReclaimPipe`
(line 158) probes it: **connect succeeds ⇒ a live process owns it ⇒ cannot
reclaim** → it falls through to the suffixed name `wmux-daemon-rizz-1`
(`attempt → ${pipeName}-${attempt}`, line 112-114). That fallback exists for
**crash zombies**, but here the owner is the *live first daemon*. Result:
**two daemons**, the second writes its `-1` pipe name to the `daemon-pipe` file,
the new renderer connects to the empty second daemon (→ terminal reset), and the
per-session pipes collide (`EADDRINUSE` on reattach).

> The TODO's two suspected causes are both real; Defect 1 is the upstream
> trigger that the original write-up under-weighted (it lumped the false-death
> into "slow OS probe" generally — it is specifically `isProcessAlive`'s
> `catch→false`, mirroring PR #87).

## Fix design (ordered — implement + codex-review each step before the next)

Guiding principle (same as PR #87): **a probe failure is `unknown`, never
`absent`/`dead`.** "Keep the live daemon" must always win ties.

### Step ① — `isProcessAlive` must not return `false` on a probe error
Split the result into `alive | dead | unknown`. A `tasklist`/`ps` **timeout or
exec error → `unknown`**, only an authoritative "no such PID" → `dead`. Callers
that gate "should I spawn?" must treat `unknown` as **"assume alive, do not
spawn over it."** (Mirror `ProcessMonitor.isDefinitelyDead`: only positive
confirmation of death authorizes the destructive branch.)
- Touch: `launcher.ts:64-77` (+ its callers at line 364 and the kill gate).
- Lowest-risk shape: return a 3-state enum; map old `true`→alive,
  old `false`(real "not listed")→dead, old `catch`→unknown.

### Step ② — `ensureDaemon` reuses a live-but-unreachable daemon instead of killing it
When the PID is `alive`/`unknown` **and** image-verified as a daemon, but the
two-shot ping failed:
- Do **NOT** SIGKILL + spawn (that nukes kept sessions). Instead **back off and
  re-ping** with a longer budget (e.g. escalating 250 → 500 → 1000 ms, total a
  few seconds — still inside the spawn budget) before considering any kill.
- Only after the *escalated* ping still fails AND the process is image-verified
  do we consider the daemon genuinely wedged. Even then, prefer a **graceful
  shutdown RPC / detach-preserving restart** over blind SIGKILL so kept sessions
  survive, or surface the failure via `DaemonRespawnController`'s budget + IPC
  rather than spawning a racing second daemon.
- Touch: `launcher.ts:376-438`, coordinate with `DaemonRespawnController`.

### Step ③ — `-N` fallback yields to a live owner (zombie-only reclaim)
In `DaemonPipeServer.start()`: when `EADDRINUSE` and `tryReclaimPipe` reports a
**LIVE owner** (connect succeeded), do **not** take `-1`. Instead **fail fast**
with a distinct error (e.g. `EDAEMON_ALREADY_RUNNING`) so the spawning daemon
**exits cleanly** and the launcher **reconnects to the existing daemon** rather
than treating `-1` as success. The `-N` suffix path stays ONLY for the
genuine-zombie case (connect refused/reset → reclaim → retry canonical name).
- Touch: `DaemonPipeServer.ts:108-145` + the spawn/handshake reader in
  `launcher.ts` (must interpret the new "already running, reconnect" signal and
  re-enter the reuse path, not loop into another spawn).
- This is the most delicate step: the daemon entrypoint and the launcher
  handshake must agree on the new exit semantics. Codex-review in isolation.

## Cross-platform liveness/probe audit (folds in the P3 TODO)
Sites where a probe failure is (or risks being) read as absent/dead:
| Site | File:line | Current | Verdict |
|---|---|---|---|
| `isProcessAlive` | `launcher.ts:74` | `catch → false` | **BAD** — Defect 1, fix in Step ① |
| `pingDaemon` | `launcher.ts:192` | `timeout → resolve(false)` | **Caller-dependent** — fine as a reachability signal; the *decision* on a timeout (Step ②) is what must change |
| `getProcessImage` (`/proc`, `ps`) | `launcher.ts:171,183` | `catch → null` | OK — `null` flows to category (c) "unverifiable" which **throws** (refuses to act). Safe. |
| `ProcessMonitor` | (PR #87) | `isDefinitelyDead` gate | **Already correct** — the template to copy. |
Principle to enforce repo-wide: **only positive confirmation of death may
authorize a destructive/spawn branch; every timeout/exception is `unknown`.**

## Test strategy
- **Unit:** `isProcessAlive` 3-state (mock a timing-out `tasklist`/`ps` →
  `unknown`, a clean "no PID" → `dead`, a hit → `alive`). `ensureDaemon` with a
  live daemon whose first two pings time out → asserts **reuse, no spawn, no
  kill**. `DaemonPipeServer.start()` against a live-owner pipe → asserts
  fail-fast (no `-1`), against a zombie pipe → asserts reclaim+retry.
- **Dynamic** (bundled daemon subprocess + RPC probe, see
  `reference_dynamic_test_pattern`): start daemon A, simulate a slow
  `isProcessAlive`, run the launcher reuse path, assert **one** daemon and the
  original sessions reattach. Then a real zombie-pipe case asserts `-1` reclaim
  still works.
- **Dogfood (required before any ship):** Quit (keep sessions) → relaunch on the
  user's actual machine; confirm: exactly one daemon process
  (`Get-CimInstance` child count, see `reference_stale_pid_in_sessions_json`),
  sessions reattach with scrollback, no `-1` pipe, no terminal reset.

## Constraints / process
- **No push / PR until user GUI dogfood passes** (project policy).
- Implement Step ① → codex review → Step ② → codex review → Step ③ → codex
  review. Do **not** batch all three; issue #54 proved this area needs
  incremental adversarial review (`reference_iterative_codex_review`).
- Independent of PR #87 (already shipped on `fix/daemon-exit-observability`) and
  of the `pty:resize` renderer fix; can branch from the same base.
