# How to handle a daemon restart

> **Goal:** keep a long-lived client correct across a wmux daemon restart and
> across cursor drift, by detecting the two distinct signals and reconciling
> state from a fresh snapshot.

Assumes you run an [event poll loop](./react-to-events.md). The contract is
[`PROTOCOL.md` §2.4–§2.5](../PROTOCOL.md#24-bootid-and-daemon-restart) and the
identity model in [`PROTOCOL.md` §6](../PROTOCOL.md#6-identity-model); this
recipe is the recovery code.

## Background: two different failures

A long-lived client faces two unrelated "you fell behind" conditions, and they
require different responses:

| Signal | Meaning | Severity |
|---|---|---|
| `resync: true` | Your cursor drifted past the in-memory ring window (you polled too slowly during a burst), **or** your cursor is in the future. The seq space is still valid; you just missed some events. | Recoverable — re-snapshot and resume. |
| `bootId` changed | The daemon process restarted under you. The entire seq space is new: every `paneId`, `ptyId`, and cursor you cached is meaningless. | Hard reset — drop everything. |

`bootId` is a UUIDv4 stamped once when the daemon's `EventBus` is constructed. It
is returned on **every** `events.poll` response, every `pane.list` response, and
in `system.capabilities().features.events.bootId` — all identical for the
lifetime of one daemon run. A different value on a later poll is the
restart signal.

## Identifier lifetimes

Which cached values survive what (`PROTOCOL.md` §6):

| Identifier | Survives daemon restart? | Invalidation signal |
|---|---|---|
| `workspaceId` | yes (session-persisted) | — (stable) |
| `paneId` | no | `bootId` change |
| `ptyId` | no | `process.exited`, or `bootId` change |
| `bootId` | no — that is the point | itself (mismatch = restart) |
| event cursor | no | `bootId` change |

`workspaceId` is the only id you can safely cache across a restart. Re-resolve
everything else from a fresh `pane.list`.

## Steps

1. **Record `bootId` on your first poll.** Store it alongside your cursor.

2. **Compare `bootId` on every subsequent poll.** If it differs from your stored
   value, the daemon restarted:
   - Drop **all** cached state — `paneId`/`ptyId` maps, last-seen metadata, the
     cursor.
   - Keep only `workspaceId` (stable across restarts).
   - Re-bootstrap: call `pane.list`, adopt its `bootId`, and resume from its
     `asOfSeq` (see step 4).

3. **Handle `resync: true` (when `bootId` is unchanged).** You drifted past the
   ring. The seq space is intact, so you do not need to drop `paneId`/`ptyId`
   caches — but you may have missed metadata-changing events, so re-snapshot to
   be safe. `droppedCount`, when present, tells you how many events you missed.

4. **Reconcile via `pane.list`, resume from `asOfSeq`.** `pane.list` returns
   `{ asOfSeq, bootId, panes }`. Every event with `seq <= asOfSeq` is already
   reflected in `panes[*].metadata`; events with `seq > asOfSeq` are the next
   ones to consume. So set `cursor = asOfSeq` and continue polling. If the
   `pane.list` `bootId` itself differs from what you just stored, treat it as a
   restart (step 2) and drop the rest of your caches too.

## Code

```js
import { connect } from './wmux-rpc.mjs';

const client = await connect(); // async — resolves to a WmuxClient
let cursor = 0;
let bootId = null;
let paneCache = new Map(); // paneId -> metadata, rebuilt on reconcile

async function reconcile(workspaceId) {
  const snap = await client.rpc('pane.list', { workspaceId });
  bootId = snap.bootId;                 // adopt the snapshot's bootId
  paneCache = new Map(snap.panes.map((p) => [p.id, p.metadata]));
  cursor = snap.asOfSeq;                // resume events from here
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await reconcile('ws-1'); // initial bootstrap

for (;;) {
  const res = await client.rpc('events.poll', { cursor });

  if (bootId && res.bootId !== bootId) {
    // DAEMON RESTART — drop every cached id and cursor, re-snapshot from scratch.
    paneCache.clear();
    await reconcile('ws-1');
    continue;
  }

  if (res.resync) {
    // CURSOR DRIFT — seq space intact, but we missed events. Re-snapshot.
    if (res.droppedCount) console.warn(`missed ${res.droppedCount} events`);
    await reconcile('ws-1');
    continue;
  }

  for (const ev of res.events) {
    if (ev.type === 'pane.metadata.changed') paneCache.set(ev.paneId, ev.metadata);
    if (ev.type === 'pane.closed') paneCache.delete(ev.paneId);
    // ... handle other types
  }
  cursor = res.nextCursor;
  await sleep(1000);
}
```

## Pitfalls

- **Do not conflate the two signals.** `resync` is recoverable by re-snapshot;
  it does **not** invalidate `paneId`/`ptyId` (the ids are still live). A
  `bootId` change invalidates everything. Check `bootId` first.
- **`workspaceId` is the only id you may cache across a restart.** Re-resolve
  `paneId`/`ptyId` from the fresh `pane.list` every time.
- **Resume from `asOfSeq`, not `0`.** Re-snapshotting and then polling from
  `cursor: 0` re-delivers the entire ring; you would reprocess events already
  reflected in the snapshot. `asOfSeq` is the exact watermark.
- **The `pane.list` `bootId` can itself reveal a restart.** If the daemon
  restarted between your last poll and your reconcile call, the snapshot's
  `bootId` is the new one — adopt it and clear caches in the same step.
- **`droppedCount` is only set on past-the-window drift.** A future-cursor
  `resync` (rare; a bogus or stale cursor) carries `resync: true` without
  `droppedCount`. Treat both the same way: re-snapshot.

## See also

- [`PROTOCOL.md` §2.4](../PROTOCOL.md#24-bootid-and-daemon-restart) and [§2.5](../PROTOCOL.md#25-snapshot-reconciliation-resync-true-and-droppedcount) — `bootId`, `resync`, the snapshot envelope.
- [`PROTOCOL.md` §6](../PROTOCOL.md#6-identity-model) — identifier lifetimes table.
- [React to events](./react-to-events.md) — the base poll loop this recipe hardens.
- [`examples/event-recorder/recorder.mjs`](../../examples/event-recorder/recorder.mjs) — live mode demonstrates `bootId`/`resync` handling.
