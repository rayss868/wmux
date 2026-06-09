# How to write pane metadata

> **Goal:** write a pane's label/role/status or a tool-private data subtree
> without clobbering another tool's writes, with an optimistic-concurrency retry
> loop and the right permission scope.

Assumes you can [connect to wmux](./connect-to-wmux.md). The metadata contract is
[`PROTOCOL.md` §1](../PROTOCOL.md#1-panemetadata-semantics); this recipe is the
write path.

## Background

`PaneMetadata` has two layers:

- **Shared display fields** — `label`, `role`, `status`. A flat, human-facing
  vocabulary that any tool may read or write. Last writer wins; wmux does not
  arbitrate.
- **`custom`** — a `Record<string, string>` namespaced by convention as
  `custom.<toolName>.<key>` (e.g. `custom.dashboard.lastRender`). Opaque to
  wmux. Deep-merged one level so cooperating tools do not clobber each other.

Every pane has a monotonic `version`, starting at `0` (never written) and
incrementing by 1 on each successful `setMetadata` / `clearMetadata`.

## Steps

1. **Pick a target.** Pass `paneId` (and `workspaceId` if you are an external
   caller — see [connect-to-wmux](./connect-to-wmux.md) on workspace scope). The
   handler resolves the pane and applies your patch.

2. **Choose a `mergeMode`.** Three values:

   | `mergeMode` | Effect |
   |---|---|
   | `'merge'` (default) | Patch top-level fields; deep-merge `custom` one level (your keys overwrite same-named keys, other keys preserved). |
   | `'replace'` | Full overwrite — the result is exactly your patch, `custom` included. Everything you omit is dropped. |
   | `'replaceShared'` | Overwrite `label`/`role`/`status`, **preserve** the whole `custom` object. Take the shared display vocabulary without disturbing other tools' subtrees. |

   The legacy boolean `merge: true|false` still works (`true` ⇒ `merge`,
   `false` ⇒ `replace`); when both are present, `mergeMode` wins. New code
   should send `mergeMode` only.

3. **Write under your own namespace.** Put tool-private data in
   `custom.<toolName>.*`, not in a bare key and not in `label`/`status` unless
   you intend to own the shared field. Example patch:
   `{ paneId, custom: { 'dashboard.lastRender': '2026-06-09T...' } }`.

4. **For coordinated writes, pass `expectedVersion`.** Read the current
   `version` first (via `pane.getMetadata` or `pane.list`), then write with
   `expectedVersion: <that version>`. If another writer committed in between,
   the write fails instead of silently overwriting them. Omit `expectedVersion`
   for fire-and-forget writes (the v2.x default — always commits).

5. **Retry on `VERSION_CONFLICT`.** A stale `expectedVersion` returns
   `{ ok: false, error }` whose `error` string contains the substring
   `"VERSION_CONFLICT"` (and the `currentVersion`). Re-read, re-compute your
   patch against the new base, and retry. Bound the loop yourself — the
   substrate provides no built-in retry.

## Code

The optimistic-concurrency retry loop (matches `PROTOCOL.md` §1.3 and the
`scripts/m0-dynamic-verify.mjs` conflict check):

```js
import { connect } from './wmux-rpc.mjs';

// connect() is async and takes an OPTIONS OBJECT; clientName scopes enforcement.
const client = await connect({ clientName: 'my-org.dashboard', clientVersion: '1.0.0' });

async function setWithRetry(paneId, workspaceId, computePatch, maxAttempts = 5) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { metadata, version } = await client.rpc('pane.getMetadata', { paneId, workspaceId });
    const patch = computePatch(metadata);
    try {
      return await client.rpc('pane.setMetadata', {
        paneId, workspaceId,
        ...patch,                  // label / role / status / custom
        mergeMode: 'merge',
        expectedVersion: version,  // optimistic concurrency
      });
    } catch (err) {
      if (!String(err.message).includes('VERSION_CONFLICT')) throw err;
      // Another writer committed between our read and our write. Loop:
      // re-read, re-merge, retry. Jittered backoff is a reasonable default.
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
    }
  }
  throw new Error('setWithRetry: maxAttempts exceeded');
}

// Claim a freshly-spawned pane only if nobody has written it yet:
await setWithRetry('p-123', 'ws-1', () => ({
  status: 'running',
  custom: { 'dashboard.taskId': 'T-42' },
}));
```

The reply on success echoes the post-commit `version`; chain writes by feeding
it back as the next `expectedVersion` without re-reading.

## Permission scoping

If you send a `clientName`, the write is gated by your declared `meta.write`
capability (see `PROTOCOL.md` §4 and
[`mcp-plugin-spec.md` §3.4](../api/mcp-plugin-spec.md#34-metadata-path-namespace)):

- `meta.write` (unscoped) — write any path, including shared `label`/`role`/`status`.
- `meta.write:custom.my-org.*` — write only single-segment children under
  `custom.my-org` (`custom.my-org.x`, not `custom.my-org.x.y`).
- `meta.write:custom.my-org.**` — write the full recursive subtree.
- `meta.write:status` — write only the shared `status` field.

`pane.setMetadata` is **all-or-nothing**: if any field in your patch falls
outside your declared globs, the entire call is rejected (`paths-partially-allowed`)
— writes never silently drop fields. Declare the narrowest glob that covers
your actual writes.

## Pitfalls

- **`VERSION_CONFLICT` surfaces as an error string, not a thrown structured
  code (over the pipe).** Match the `"VERSION_CONFLICT"` substring on the
  error message, exactly as `scripts/m0-dynamic-verify.mjs` does.
- **`'replace'` drops `custom`.** If you only meant to take the shared fields,
  use `'replaceShared'`, not `'replace'`.
- **`expectedVersion: 0` is a real guard, not "no check".** It succeeds only if
  the pane has never been written. Omitting `expectedVersion` is "no check."
- **`custom` is one level deep-merged on `merge`.** Sub-objects are not
  recursively merged — a `custom` key's value is a string; structure your data
  as dotted flat keys (`custom.dashboard.task.id`) rather than nested objects.
- **Validation failures do not bump `version`.** Oversize values / bad types
  return a descriptive error and leave the stored version untouched. Limits are
  in [`stability.md`](../api/stability.md#validation-limits-v30-baseline-values).
- **All-or-nothing means a single out-of-scope field rejects the whole write.**
  Splitting a shared-field write from a `custom.*` write into two calls is the
  fix when your declared scope only covers one of them.

## See also

- [`PROTOCOL.md` §1](../PROTOCOL.md#1-panemetadata-semantics) — layered status, namespacing, version + `expectedVersion`, mergeMode.
- [`mcp-plugin-spec.md` §3.4 / §4.4](../api/mcp-plugin-spec.md#34-metadata-path-namespace) — `meta.write` globs and the worked glob example.
- [`examples/event-recorder/recorder.mjs`](../../examples/event-recorder/recorder.mjs) — its `--annotate` mode writes a shared `label` plus `custom.event-recorder.{lastSeq,count}` onto the watched pane every N recorded events (default 10), via the optimistic-concurrency retry loop above.
