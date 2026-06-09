# Issue #113 — Verify first-party MCP identity beyond the self-asserted `clientName`

Status: DESIGN (no code change proposed in this revision — see §7 recommendation)
Author: sub-agent design pass, 2026-06-09
Relates to: #109 (enforce-mode lockout fix, shipped), #112, `plans/first-party-mcp-trust.md`
Constraint: this document analyzes feasibility only. It does not modify the enforcer,
the registrar, the pipe server, or the wire format.

---

## 0. TL;DR (the adversarial conclusion up front)

**Recommendation: DEFER identity verification. Strengthen documentation + the existing
source-invariant allowlist tests instead.**

The gap #113 describes is real but *dominated by a wider gap that is already open by
design*, so closing it in isolation buys close to nothing:

- To spoof `clientName=claude-code` over the daemon pipe at all, a process must first
  pass the daemon auth-token check (`PipeServer.processLine`, timing-safe compare before
  dispatch). On a single-user OS the token lives in an owner-readable file and the
  same-user attacker *is* the owner — so any attacker capable of the spoof already holds
  the token.
- With the token, the attacker has a **strictly cheaper and strictly wider** path than
  impersonating the bundled server: send RPCs with **no `clientName` envelope at all**.
  The enforcer's legacy grandfather branch (`PermissionEnforcer.check`, the
  `if (!input.ctx.clientName) return allow` line) allows **every** method — including
  `daemon.*`, `workspace.new`, and company mutation — not just the curated
  `FIRST_PARTY_METHODS` subset.
- Therefore verifying first-party identity, while leaving the legacy grandfather and the
  shared token in place, removes the *narrower* of two attacker paths and leaves the
  *wider* one untouched. It is security theater until the token becomes per-identity and
  the legacy path is closed — which is a different, much larger piece of work.

Neither proposed mechanism actually beats the shipped scoped allowlist either:

- **Peer-PID attestation** cannot cover the Windows TCP loopback fallback at all, and even
  where it works it resolves to a generic `node.exe` that is indistinguishable from any
  other same-user node process. It does not separate the bundled server from a hostile
  same-user node script.
- **Per-launch nonce** is infeasible by construction: the daemon does not own the spawn
  (Claude Code does), and the only injection channel it controls — `args` in a
  world-readable `~/.claude.json` — is a static, file-readable value, i.e. exactly as
  self-asserted as `clientName`.

The honest framing: #113 is a request to add a *verified* identity to a system whose
trust root is, by explicit spec design, the user's approval and a shared admission token
— not a per-process cryptographic identity. Until that trust root changes, identity
verification on one path is marginal.

---

## 1. Current shipped state (verified against code)

### 1.1 What recognizes "first party"
- `src/main/mcp/firstParty.ts`: `FIRST_PARTY_CLIENT_NAMES = {'claude-code'}` and a
  curated `FIRST_PARTY_METHODS` set (~45 methods). The set deliberately **excludes**
  `daemon.*`, `workspace.new`, `company.create`, and other reserved/mutation surface, so
  even a recognized caller cannot reach them through the first-party path.
- `src/main/mcp/PermissionEnforcer.ts` (the first-party branch, ~lines 200-207) gates the
  allow on three guards:
  1. `isFirstPartyClient(ctx.clientName)` — exact-match the self-asserted name.
  2. `!trustLookupFailed` — a corrupt/unreadable trust DB is an *unknown* state, so the
     bypass declines and falls through to fail-closed enforcement (a `denied` row that
     simply couldn't be read must not be silently bypassed).
  3. `trust?.status !== 'denied'` — an explicit operator `denied` still wins.
  A method outside the allowlist also falls through to normal enforcement, so a coverage
  gap surfaces as a rejection rather than a silent widening.
- `firstParty.test.ts` is a **source-invariant** test: it parses `src/mcp/**` for every
  `callRpc`/`sendRpc` method literal and fails if the allowlist drifts from the tools the
  bundled server actually calls. This is the real guarantee that bounds blast radius.

### 1.2 Where `clientName` comes from (the crux of #113)
- `src/mcp/index.ts` `wireClientIdentityHook()` reads `underlying.getClientVersion()` —
  the **MCP client's** `clientInfo.name` from the stdio `initialize` handshake — and
  stamps it via `setClientIdentity(name, version)`.
- The MCP *client* connecting to the bundled server is **Claude Code itself**, which
  reports `name = 'claude-code'`. So the name is not a property the bundled server chose;
  it is a property of *whoever launched it*. **Every** MCP server Claude Code spawns
  reports `clientName=claude-code` to the daemon. That is precisely why the name cannot
  distinguish the bundled wmux server from any other Claude-Code-launched server.
- `src/main/pipe/RpcRouter.ts` lifts `request.clientName` verbatim into `ctx.clientName`
  (trim + non-empty), no verification.
- `src/shared/rpc.ts` documents the stance explicitly: *"this is a declared identity, not
  a verified one. There is no root-of-trust; any caller can self-name."*

### 1.3 The admission + trust model that bounds the threat
- **Shared admission token.** `PipeServer.processLine` rejects any request whose `token`
  does not timing-safe-equal the daemon auth token, *before* dispatch and before consuming
  rate-limit budget. The token is an admission gate, not a per-plugin identity.
- **Legacy grandfather (the wider hole).** In `PermissionEnforcer.check`, a request with no
  `clientName` returns `allow` for *all* methods. This exists so substrate ships without
  breaking pre-v2.10 / non-MCP RPC callers. It is wider than the first-party allowlist.
- **Single-user OS reality.** The auth token lives in an owner-readable file
  (`~/.wmux-auth-token`); `~/.claude.json` is plain-written with no ACL. Any same-user
  process can read both. No purely-local secret (env, args, file, compiled constant) can
  cryptographically separate the bundled server from a determined same-user impersonator.

### 1.4 Blast-radius boundary (what the allowlist already buys)
A `clientName=claude-code` impersonator that holds the token reaches **only**
`FIRST_PARTY_METHODS`: pane/terminal/browser/a2a/company-a2a read+write within the
caller's workspace scope, plus `mcp.identify`/`mcp.claimWorkspace`. It does **not** reach
`daemon.shutdown`, `daemon.createSession`, `workspace.new`, `company.create`, or
`hooks.signal`. Pinned by the source-invariant test. This is a meaningful bound against a
*name-only* impersonator — but see §6 for why a *token-holding* attacker bypasses it via
the legacy path anyway.

---

## 2. Issue #113 acceptance criteria (verbatim intent)

1. The first-party bypass applies only to a server whose identity is **verified**, not
   merely self-asserted.
2. Works cross-platform (win32 + darwin + linux), or is explicitly gated per-platform with
   a documented fallback.
3. Existing scoped-allowlist tests still pass; new tests cover a spoofed `clientName` being
   rejected.

A faithful reading of (1) is "tell the bundled wmux MCP server apart from any other MCP
server Claude Code launched." The two options below are measured against that bar, and
against the implicit fourth criterion: **does it actually reduce real risk beyond the
shipped allowlist?**

---

## 3. Option A — Peer-credential / peer-PID attestation

Idea: when the bundled server connects, recover the OS-level identity of the peer process
(its PID, then its executable image / command line) and attest it against the known
bundled MCP server binary, rather than trusting the `clientName` on the envelope.

### 3.1 Platform mechanics
- **win32 (named pipe):** `GetNamedPipeClientProcessId(handle)` → client PID.
- **linux (unix socket):** `getsockopt(fd, SOL_SOCKET, SO_PEERCRED)` → `{pid, uid, gid}`.
- **darwin (unix socket):** `getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID)` (+ `LOCAL_PEERCRED`
  for uid/gid).

### 3.2 Hard blockers (verified)
1. **Node has no peer-credential API.** `net.Server` / `net.Socket` expose no
   `SO_PEERCRED` / `GetNamedPipeClientProcessId` surface. Every platform path requires a
   **native addon** (N-API/node-gyp) that pulls the underlying fd/HANDLE out of libuv and
   issues the syscall. That is a prebuilt-binary-per-(platform×arch×node-abi) maintenance
   burden on a project that currently ships zero native addons — a category change in the
   build and release pipeline.
2. **The Windows TCP loopback fallback has no peer identity at all.**
   On Windows `PipeServer.start()` brings up `startTcpFallback()` unconditionally, in
   parallel with the named pipe — it listens on `127.0.0.1:<random>` on every launch, not
   only when the pipe is unavailable. A TCP socket carries no peer PID. The only recovery is
   `GetExtendedTcpTable` (port→PID), which is a *separate, racy* syscall: the ephemeral
   client port can be reused, and the lookup is a TOCTOU window distinct from the
   connection. So Option A is **structurally unable to cover the fallback transport** — it
   would have to either disable the loopback listener (a regression for every Windows user,
   since it always runs alongside the pipe) or leave a documented un-attested hole that an
   attacker simply targets.
3. **A verified PID is still a generic `node.exe`.** The decisive defeat. The bundled
   server is launched as `node <resources>/mcp-bundle/index.js` **by Claude Code, not by
   the daemon** (`McpRegistrar` writes `{command:'node', args:[script]}` to
   `~/.claude.json`; Claude Code owns the spawn). PID→image path therefore resolves to the
   user's `node` interpreter — identical to *every other* Claude-Code-launched node MCP
   server and to any hostile same-user node script. To go further you must attest **argv**
   (the script path), which means:
   - Reading another process's command line cross-platform (`/proc/<pid>/cmdline` on linux;
     `sysctl KERN_PROCARGS2` on darwin; `NtQueryInformationProcess`/WMI on win32) — more
     native surface, and **racy** (PID recycling: the PID you attest may not be the PID that
     sent the next RPC on a connection-per-request pipe).
   - The script path you would match against is **world-readable** under `resources/`. A
     same-user attacker runs `node <that exact path-shaped argv>` — or just renames argv to
     match — and passes attestation. argv is not a secret and is forgeable by the same user.

### 3.3 Verdict on Option A
Closes the gap only against a *different-image* attacker (e.g. a third-party MCP server
that is a Python or compiled binary). Does **not** close it against a same-user node
process, which is the realistic threat on a single-user box. Cannot cover the TCP
fallback. Requires a 3-platform native addon. **Does not beat the shipped allowlist:** the
allowlist already bounds an impersonator to the curated method set without any of this
cost, and Option A still cannot stop a same-user node impersonator from reaching that same
set.

---

## 4. Option B — Per-launch nonce injected by the daemon

Idea: the daemon mints a fresh nonce per server launch, injects it into the bundled
server's environment/args, and requires it on every RPC envelope. A spoofer that never
received the nonce is rejected.

### 4.1 Why it is infeasible as specified (verified)
1. **The daemon does not own the spawn.** `McpRegistrar.register` writes a static
   `{command:'node', args:[script]}` entry to `~/.claude.json`. **Claude Code** decides
   when to launch and relaunch the server; the daemon is never notified of a launch and
   cannot mint a per-launch secret at launch time. A "per-launch" nonce requires control of
   the launch — which the daemon does not have. The issue itself states this.
2. **`env` is deliberately unavailable.** `McpRegistrar` omits the `env` field on purpose
   (Claude Code may *replace*, not merge, the child environment, breaking
   PATH/USERPROFILE). So the env channel the nonce idea assumes is closed.
3. **The only channel the daemon controls — `args` — is world-readable and static.** Args
   are appended to the `~/.claude.json` entry, which has no ACL. A value placed there is:
   - **Self-asserted, identically to `clientName`.** Any same-user process reads
     `~/.claude.json` and replays the arg. Verifying it proves nothing the name didn't.
   - **Static, not per-launch.** The registrar only rewrites the entry when args change
     (the "args changed → rewrite" guard). To rotate per launch the daemon would have to
     rewrite `~/.claude.json` immediately before each Claude Code launch and know when that
     is — which returns to blocker (1).

### 4.2 Verdict on Option B
A static, file-readable arg is a **second bearer secret in a worse location** than the
auth token, with zero added separation against the same-user attacker. A genuinely
per-launch nonce is impossible without the daemon owning the spawn lifecycle. **Does not
beat the shipped allowlist** — it is strictly worse than doing nothing.

---

## 5. Feasibility matrix

| Dimension | Shipped: scoped allowlist (name-only) | A: peer-PID attestation | B: per-launch nonce (args) |
|---|---|---|---|
| win32 named pipe | n/a (name only) | native addon: `GetNamedPipeClientProcessId` | static arg, world-readable |
| win32 TCP fallback | covered (same enforcer) | **impossible** (no peer id; port→PID racy) | static arg, world-readable |
| linux | n/a | native addon: `SO_PEERCRED` | static arg, world-readable |
| darwin | n/a | native addon: `LOCAL_PEERPID` | static arg, world-readable |
| Engineering effort | shipped (~2 files + tests) | high: 3-platform native addon + argv attestation + fd extraction from libuv | low code, but conceptually broken |
| Hot-path blast radius | none (pure fn, already on path) | **per-RPC syscall** (PID lookup) on connection-per-request pipe → latency + TOCTOU risk on every MCP call | per-RPC string compare (cheap) but meaningless |
| Distinguishes bundled server from same-user node? | no (name only) | **no** (resolves to generic `node.exe`; argv forgeable) | **no** (arg readable + replayable) |
| Distinguishes from different-image 3rd-party server? | no | yes (image path differs) | no |
| Beats the shipped allowlist on real risk? | baseline | **no** | **no (worse)** |
| Survives a token-holding same-user attacker? | no (see §6) | no | no |

The two rightmost behavioral rows are the verdict: **neither option distinguishes the
bundled server from a same-user node impersonator, which is the only attacker that matters
on a single-user OS, and neither survives a token holder.**

---

## 6. Quantifying the marginal gap (why identity verification is near-moot today)

Walk the attacker's actual options, all of which presuppose the daemon auth token (without
it, `PipeServer` rejects before dispatch):

| Attacker path | clientName | Enforcer outcome | Reach |
|---|---|---|---|
| Honest 3rd-party plugin (no token) | any | rejected at PipeServer (no token) | none |
| Token holder, **no envelope** | absent | **legacy → allow** | **ALL methods** incl. `daemon.*`, `workspace.new`, `company.*` |
| Token holder, spoofs `claude-code` | `claude-code` | first-party → allow | `FIRST_PARTY_METHODS` subset only |
| Token holder, declares + waits for approval | own name | trusted after user click | declared caps only |

The middle two rows are the whole story. **Spoofing `claude-code` is a *downgrade* for an
attacker** — it yields the curated subset, whereas omitting the envelope yields everything
via the legacy grandfather. A rational token-holding attacker never spoofs the name; they
use the legacy path. So:

> Verifying first-party identity closes a narrower hole (the allowlist subset) while the
> wider hole it sits next to (legacy grandfather → all methods, same shared token) stays
> open. The marginal risk reduction is approximately **zero** until *both* the legacy
> grandfather is closed *and* the shared token is replaced by a per-identity credential.

This is the adversarial heart of the matter: #113 asks to harden one self-asserted
identity check while the system's trust root remains "hold the shared token, and you may
even skip identifying yourself." Identity verification is premature against that backdrop.

(Note: the same-user token holder is, by the spec's own threat model, already out of scope
— "it can do anything the user can." That is exactly why the marginal gap is small.)

---

## 7. Recommendation

**(a) Defer the verified-identity work. Harden docs + tests now; revisit only as part of a
broader trust-root change.**

Concretely:

1. **Document the residual risk explicitly** in `firstParty.ts` header and the plugin spec:
   first-party recognition is best-effort and *not a security boundary against same-user
   code*; the real boundary is the OS user account + the daemon auth token. State that a
   token-holding same-user process already has a wider path (legacy grandfather) than
   first-party spoofing, so name verification is intentionally not attempted. (Do **not**
   touch `docs/PROTOCOL.md` — owned by another work-stream.)
2. **Keep the source-invariant allowlist test as the load-bearing control.** It is what
   actually bounds blast radius, and it has zero hot-path cost. Add a regression test
   asserting that the first-party path can never reach a reserved/mutation method even if
   the allowlist is edited (belt-and-suspenders against drift).
3. **Record #113 as accepted-known-limitation**, cross-linked to the two real prerequisites
   below, rather than shipping a mechanism that the matrix shows does not move real risk.

**Pursue a verified mechanism only if both prerequisites land first** (these, not #113, are
the real root if same-user isolation ever becomes in-scope):

- **P1 — Close / scope the legacy grandfather.** As long as no-envelope → allow-all, no
  amount of first-party verification matters. This is the dominant hole.
- **P2 — Per-identity admission tokens.** Replace the single shared daemon token with a
  credential bound to an identity, so "holds a token" stops implying "may impersonate
  anyone." Only once admission is per-identity does attesting *which* identity connected
  become meaningful.

If, after P1+P2, a verified first-party signal is still wanted, **peer-PID attestation is
the only option with any verification value** — but it must be gated per-platform with the
TCP-fallback hole documented, and it still cannot distinguish same-user node processes, so
its value is limited to excluding *different-image* third-party servers. **Per-launch nonce
should be dropped entirely**: it is infeasible while Claude Code owns the spawn and is
strictly worse than the status quo.

### One-line verdict
Neither peer-PID attestation nor a per-launch nonce beats the shipped scoped allowlist on a
single-user OS, and both are dominated by the still-open legacy grandfather + shared-token
path — so **defer #113, document the limitation, and treat the legacy grandfather and
per-identity tokens as the real prerequisites.**
