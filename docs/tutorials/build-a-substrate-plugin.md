# Build a substrate plugin

This is a single guided lesson. By the end you will have connected an external
program to a running wmux, watched real lifecycle events stream out of it,
written metadata back into a pane header, and walked the full plugin identity +
approval flow. You do not need to have read any wmux source.

**What you need:**

- Windows with PowerShell (the commands below are PowerShell; the plugin code is
  cross-platform Node ≥ 18).
- A wmux install. If you have one, skip step 1.
- A clone of this repo (for the reference plugin under `examples/event-recorder/`).

The plugin you will run is the **event recorder** — a ~150-line program that
connects to wmux, polls the event bus, and prints each event as one JSON line.
It lives at [`examples/event-recorder/`](../../examples/event-recorder/) with
three files: `recorder.mjs` (the loop), `wmux-rpc.mjs` (the connection client),
and `README.md`.

---

## 1. Install and run wmux

Install wmux (winget shown; Chocolatey and the GitHub release also work) and
launch it:

```powershell
winget install wmux
```

Then start it from the Start menu, or from a terminal:

```powershell
wmux
```

You should see the wmux window with one workspace and one terminal pane. Leave
it open — everything below talks to this running instance.

> wmux writes its auth token to `~/.wmux-auth-token` and listens on the named
> pipe `\\.\pipe\wmux-<your-username>` as soon as it starts. The recorder finds
> both automatically.

---

## 2. Run the recorder once, in legacy mode

Open a **separate** PowerShell window (not a wmux pane — we want to prove an
external program can connect). Go to the repo and run the recorder in
`--legacy --once` mode:

```powershell
node examples/event-recorder/recorder.mjs --legacy --once
```

- `--legacy` sends no `clientName`, so wmux grandfathers the connection through
  its permission gate (always allowed). This lets you see real output before
  touching the identity flow.
- `--once` polls once from the start of the ring (with a few bounded
  reconciliation hops if the ring already wrapped past the oldest event), prints
  what it finds, and exits.

You will see one JSON line per event already in the ring — at minimum a
`pane.created` and a `process.started` from when wmux launched its first pane.
A line looks like:

```jsonc
{"seq":2,"ts":1749470000123,"workspaceId":"ws-1","type":"process.started","ptyId":"pty-1","shell":"pwsh.exe"}
```

That is a real event off the live bus. If you see lines, your external program
is authenticated and reading the substrate.

> **If it prints nothing:** the ring may be empty if wmux just started and
> nothing has happened. Move on to step 3 — the live loop will show events as
> you create them.

---

## 3. Run it live

Now run without `--once` so it polls continuously:

```powershell
node examples/event-recorder/recorder.mjs --legacy
```

It prints any backlog, then waits. Each poll passes back the opaque
`nextCursor` from the previous poll, so you only ever see new events. Leave this
window running and visible.

---

## 4. Trigger an event by splitting a pane

Switch to the wmux window. Split the focused pane — press the wmux prefix then
the split key (default: `Ctrl+B` then `%` for a horizontal split or `"` for a
vertical split, or use the pane menu). A new terminal pane appears.

Switch back to the recorder window. You will see new lines appear, in this
shape:

```jsonc
{"seq":7,"ts":...,"workspaceId":"ws-1","type":"pane.created","paneId":"p-2"}
{"seq":8,"ts":...,"workspaceId":"ws-1","type":"process.started","ptyId":"pty-2","shell":"pwsh.exe"}
```

You just watched a UI action in wmux flow through the substrate to an external
program in real time. Note the two producers: `pane.created` comes from the
renderer, `process.started` from the main process — they can arrive in either
order (this is the cross-producer ordering caveat; use `ts` if order matters).

---

## 5. Write back: `--annotate`

So far the recorder only reads. Stop it (`Ctrl+C`) and restart in `--annotate`
mode:

```powershell
node examples/event-recorder/recorder.mjs --legacy --annotate
```

Now, every N recorded events (default 10, tunable with `--annotate-every`), the
recorder calls `pane.setMetadata` on the **pane it is watching** (the first pane
it saw). It writes a `label` onto that pane and records its own counters under
`custom.event-recorder.*`. Keep generating events — split a few panes, or just
wait while it polls — until it crosses the threshold.

Look at the **watched pane's header** in the wmux UI: it now shows the label the
recorder wrote. You wrote into the shared display vocabulary — the same `label`
field the wmux UI reads — from an external process. That is the round trip:
read events, write metadata, see it in the UI.

> The recorder writes with `mergeMode: 'merge'`, so it only sets `label` and its
> own `custom.event-recorder.*` keys; anything else on the pane is preserved.

---

## 6. Graduate to the real identity + approval flow

`--legacy` was training wheels. A real plugin announces itself so the user can
approve exactly what it is allowed to do. Stop the recorder and run it **without**
`--legacy`:

```powershell
node examples/event-recorder/recorder.mjs --annotate
```

Now the recorder:

1. Sends a `clientName` (`wmux-examples.event-recorder`) on every request.
2. Calls `mcp.identify({ name, version })` — registers as `unconfirmed`.
3. Calls `mcp.declarePermissions({ permissions: [...] })` declaring exactly the
   six capabilities it needs, each scoped to the method that requires it:
   - `events.subscribe` — gates `events.poll`.
   - `workspace.read` — gates `workspace.list`.
   - `pane.read` — gates `pane.list`.
   - `meta.read` — gates `pane.getMetadata` (read the current version before an
     optimistic-concurrency write).
   - `meta.write:label` — write the shared `label` field, which shows in the
     pane header.
   - `meta.write:custom.event-recorder.*` — write its own namespaced subtree.
4. Starts polling.

Because wmux's production default is **enforce** mode, the first real
`events.poll` comes back **rejected**, not with data:

```jsonc
{"ok":false,
 "error":"events.poll: awaiting user approval (promptId=abc123)",
 "rejection":{"reason":"identity-status","status":"unconfirmed",
              "pendingApproval":{"promptId":"abc123"}}}
```

This is expected. The recorder detects `pendingApproval` and retries on a small
backoff (the `withApprovalRetry` idiom). Meanwhile, look at the **wmux window**:
an approval dialog has appeared, showing the plugin's name and the capabilities
it declared.

**This step needs the GUI** — the approval prompt is a wmux UI surface. Click
**Approve**. The plugin's status moves to `trusted`. The recorder's next retry
succeeds and events start streaming again, exactly as in step 3 — but now the
plugin is a named, user-approved identity instead of an anonymous legacy caller.

> If you click **Deny**, the rejection's `status` flips to `denied` on the next
> retry and the recorder stops — the substrate will keep denying it. To re-grant,
> edit `~/.wmux/plugin-trust.json` (or re-run and approve).

---

## What you learned

- wmux is a **terminal substrate**: it owns panes, terminal I/O, and an event
  bus. You build workflow logic on top by connecting over its JSON-RPC socket.
- An **external program** authenticates with the token from `~/.wmux-auth-token`
  and connects to the per-user named pipe (no install hook, no plugin manager).
- The **event bus is pull-based**: `events.poll(cursor)` with an opaque cursor;
  there are eight event types including `agent.lifecycle`.
- **Metadata is the write surface**: `pane.setMetadata` writes shared display
  fields (`label`/`role`/`status`) and tool-private `custom.<tool>.*` subtrees,
  and the wmux UI reads them.
- **Identity + approval** is the difference between a `legacy` grandfathered
  caller and a named plugin the user explicitly trusted. Enforce mode rejects an
  unconfirmed plugin with a `pendingApproval` promptId; you retry until the user
  approves in the UI.

## Where to go next

**How-to guides** (task recipes, when you know what you want):

- [Connect to wmux](../how-to/connect-to-wmux.md) — token, endpoint, TCP fallback, wire framing.
- [React to events](../how-to/react-to-events.md) — the production poll loop and all eight event types.
- [Write pane metadata](../how-to/write-pane-metadata.md) — mergeMode, optimistic concurrency, permission scope.
- [Handle a daemon restart](../how-to/handle-daemon-restart.md) — `bootId` vs `resync`, reconciliation.

**Reference** (the exact contract):

- [`api/inventory.md`](../api/inventory.md) — every RPC method, MCP tool, and event type with stability tier.
- [`PROTOCOL.md`](../PROTOCOL.md) — the wire-level substrate contract.
- [`api/mcp-plugin-spec.md`](../api/mcp-plugin-spec.md) — identity, the `wmuxPermissions` grammar, and the enforcement contract you walked in step 6.
