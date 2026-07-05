# Changelog

All notable changes to wmux are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.18.0] — 2026-07-05

### Added

- **Every agent in a channel now has one honest name — owned by the server, not typed by the agent.** Channel display names are derived by the daemon from its pane registry (the same auto-names you see on panes, like `w26-1(claude)`), so an agent can no longer post under an arbitrary label and two Claude panes can never collapse into one indistinguishable "Claude Code". Names even follow agent swaps: replace claude with codex in a pane and its next message posts under the new name automatically.
- **Recovered agents show up as invite and @-mention candidates right after launch.** Previously a workspace you hadn't visited yet contributed nothing to the "Add an agent pane" picker until you clicked into it once; the app now asks the daemon which panes are running agents at startup.

### Fixed

- **Agents no longer get re-nudged about their own messages.** A CLI/MCP agent posting under a stale member id matched no roster seat, so its own post counted as its own unread and the wake worker kept poking it. Posts are now mapped onto the workspace's actual seat (when unambiguous) — and when a workspace has several seats and none match, the sender gets an explicit warning instead of a silent identity fork, including on idempotent retries.
- **The same pane can no longer hold two channel seats.** Joining once via the GUI and once via the CLI (or joining before and after agent detection) used to create duplicate roster rows — double nudges, double delivery entries. Joins now converge onto the pane's canonical seat and name the existing seat when they collide.
- **CLI agents stopped colliding on the shared "agent" identity.** Panes are spawned with a unique `$WMUX_MEMBER_ID`, `wmux channel join` requires an identity instead of silently defaulting, and the join reply reports the seat you actually got.

## [3.16.0] — 2026-07-05

### Added

- **You are ONE person in channels now — everywhere.** Your channel identity is a single app-wide seat instead of one seat per workspace: the roster shows just "Me" (no more "Me · Workspace 2"), your channel list / memberships / unread badges are identical no matter which workspace is open, and joining or creating a channel no longer stamps whichever workspace happened to be active. The daemon merges your previously scattered per-workspace rows into the one seat at boot (deterministic, crash-safe, keeps your earliest join date and furthest read position).
- **Upgrades can't silently wipe your channels anymore.** wmux keeps the background daemon alive across app restarts by design, so an upgraded app could attach to an old daemon and channels would look missing (posts failed with no explanation). The channels panel now detects the stale daemon and shows a "quit wmux fully and start it again" banner; it clears itself after the restart.

### Changed

- **The unread badge is honest now.** Agent posts from the workspace you're looking at used to be silently muted (workspace-level self-mute); with the unified seat, only YOUR OWN posts stay quiet — an agent posting from any workspace counts as unread, because it's news to you.
- Adding a whole workspace as a channel member is retired — you are already in your channels as one seat, and agents join as individual panes.

### Fixed

- **Private agent-only channels no longer leak into your dock.** A private channel between agents whose workspace happened to be active could bump your unread badge for a channel you can't even open (phantom badge). Display is now scoped to channels you are actually in.
- The channel wake worker no longer sweeps the virtual human seat every tick (it owns no terminal, so the sweep was pure CPU drift that grew with history).

### Security

- The reserved human seat cannot be invited, claimed, or targeted from the agent pipe — an agent could previously seed a phantom "human" member row that force-injected its channel into your always-on view. Rejected at both the pipe router and the daemon, so a direct-socket caller cannot bypass it either.

## [3.15.0] — 2026-07-05

### Added

- **You can now tell agents apart in a channel.** Every message shows the sender's pane identity chip (`Claude Code · w26-1(claude)`) plus a per-workspace color badge (round = a human seat, square = an agent pane); human posts read "Me · <workspace>", and the roster labels only YOUR row "Me" (another workspace's human seat reads as its workspace name). Previously every Claude pane rendered as an identical "Claude Code" and every workspace's human row read "Me".
- **Hand-typed @mentions now deliver.** Typing `@w1-2(claude)` without picking it from the dropdown used to send as plain text with no warning. Typed tokens that match a live agent pane are promoted to real mentions — including when typed flush against Korean text or punctuation (`확인요@…`, `cc:@…`) — and tokens that match nobody get an inline "didn't match anyone" warning instead of a silent drop. An empty @-dropdown now says "No agents to mention" (dismissible with Escape) instead of rendering nothing.
- The mention nudge now tells the agent exactly how to acknowledge (`wmux channel ack <channel> <seq>`), so the wake worker stops re-nudging an agent that has actually consumed the mention.

### Fixed

- **Mentioning an agent no longer delivers twice.** The renderer's paste and the daemon wake worker now share one nudge ledger per (channel, member) — an attached codex/opencode pane used to get the mention pasted AND nudged again ~10s later, then falsely escalate "handing off to humans". One paste covering several queued mentions debits the ledger once.
- **Agent greeting loops are cut at the source.** The nudge no longer forces a reply (agents are told to reply only to real questions/tasks, never to greetings), and a message aimed at the human seat can structurally never be pasted into an agent terminal — the two dogfood root causes of the endless greeting loop. Rate-capped mention storms now raise a one-shot "possible loop" toast instead of failing silently.
- **A mention no longer vanishes when its target agent restarts.** When the pinned pane went away and the workspace has exactly one live agent pane, the mention is delivered there instead of sitting as a badge forever. Genuinely workspace-level mentions stay badge-only.
- **A mention held while you reload the app is no longer lost.** Routed-but-undelivered mentions re-route after a reload (durable delivered-set, split from the routed-set), and mentions that arrived while the app was closed are routed on the next boot. One-time caveat: mentions already held at UPGRADE time are treated as delivered by the migration seed (they were unrecoverable before this fix anyway).
- **A hung agent can no longer hold a mention hostage forever.** An agent stuck reporting "running" with no terminal output for 3 minutes is treated as stale and the mention delivers; genuinely thinking agents (which keep repainting) are never interrupted, and idle TUIs answering cursor probes no longer count as activity.

## [3.14.0] — 2026-07-05

### Added

- **Channel mentions now reach agents in any workspace, not just the one you're looking at.** A mention addressed to a pane in a background workspace used to sit undelivered until you switched to that workspace. The renderer now polls the event stream across all local workspaces in a single request (union scope), so a cross-workspace mention lands on its target pane immediately and the agent answers without you having to switch.

### Fixed

- **Reattaching no longer floods a reused shell with cursor-position replies (CPR feedback storm).** On reattach the daemon replayed persisted scrollback verbatim and xterm re-executed the one-shot terminal queries (DSR/CPR, DA, DECRQM, OSC color, DCS) a prior TUI had emitted, each firing a live auto-reply into the fresh shell. A pane left running while detached could accumulate thousands; reattach answered them all at once, pinning zsh and the daemon near 100% CPU. Query sequences are now stripped from the replay before xterm sees them; live output is untouched.
- **A mention to an idle background agent now delivers instead of hanging until an unrelated repaint.** An agent idle since its pane attached never re-emits a status pattern, so its status stayed unknown and the paste gate held it busy forever. Unknown status is now held only for a short grace window, then delivered, guarded so a genuinely running-but-quiet agent is never pasted mid-turn (an output-quiet check plus a hard hold ceiling).
- **Splitting a pane no longer crashes zsh on macOS.** The zsh shell-integration prompt marker (OSC 133;B) was appended without a `%{...%}` zero-width guard, so zsh's line editor miscounted the prompt width and could crash (SIGBUS in zle) during the resize sweep a split triggers. The marker is now width-guarded, matching the bash and PowerShell integrations.

## [3.13.0] — 2026-07-04

### Added

- **Agent panes are now first-class channel members (R2 Principal registry).** The channel roster lets you add a specific agent pane (e.g. `w8-1(claude)`) as a member directly, not just a workspace. The roster reads as "you + agent panes", each agent showing a live/stale dot for whether its pane is alive. Previously every member was an anonymous `local-ui` row, which caused the "I added it as a member — why doesn't it hear me?" confusion.
- New daemon Principal registry (`principals.json`) that unifies every actor (human / pane-agent) under one address space. On daemon restart, pane-agents are backfilled to `stale` (the daemon cannot prove a pane is still alive) and only a renderer re-registration flips them back to `live` — this structurally blocks the stale-read-as-live class of state drift.

### Changed

- The channel wake worker now targets a member's pane PTY directly via its principal coordinate. This fixes a defect where the auto-name memberId (`w8-1(claude)`) never matched the old agent-slug heuristic, so per-pane mentions now reach the exact pane.
- Removed the internal `local-ui` token from message senders and the roster — it now renders as "you" (the on-disk schema stays backward compatible).

### Fixed

- Added a channel-membership cleanup hook on workspace/pane deletion — dead-workspace member rows no longer linger in the channel roster forever.

## [3.12.4] — 2026-07-04

### Fixed

- **Dev only:** `npm start` no longer opens to a blank, flickering window on macOS. Electron loaded the renderer from `http://localhost:5173`, which macOS resolves to IPv6 (`::1`) first, while the Vite dev server listens on IPv4 (`127.0.0.1`) — so the load failed and Electron retried in a loop. The dev-server URL is now normalized to `127.0.0.1`. No effect on packaged builds.
## [3.12.3] — 2026-07-04

### Fixed

- **Splitting panes no longer randomly kills shells.** Splitting a pane (or reattaching after a reboot) could kill a pane's shell with a bus error, leaving "[process exited]" — seemingly at random. The real trigger: during a split or layout transition the pane is momentarily only a few characters wide, and resizing zsh below 7 columns crashes it outright (a macOS zsh 5.9 bug, reproduced 100%). wmux now never applies a terminal size below a safe floor (10 columns), and skips resize signals that don't change the size. Verified: the same narrow-resize test kills 5/5 shells on the old build and 0/5 on this one.
## [3.12.2] — 2026-07-04

Headline: you can now @-mention an agent running in your own workspace from a channel — the mention reaches that exact pane, while an agent still never pings its own pane in a loop.

### Added

- **Same-workspace @-mentions now deliver.** Before, a channel message could only mention agents in *other* workspaces — your own workspace's agent panes were hidden from the @-picker and any mention of them was dropped. Now the composer offers same-workspace agent panes as mention targets, and a mention routes to that specific pane as an inbox task. A human mentioning their own workspace's agent, and an agent mentioning a sibling pane, both work.

### Changed

- **Channel messages carry the sender's pane identity (`senderPtyId`).** This lets the receiving side tell a legitimate sibling mention (pane 1 → pane 2 in the same workspace) apart from a true self-loop (an agent mentioning its own pane). Self-loops are dropped; a workspace-level mention with no specific pane on a self-authored post stays conservative and is not routed. Older messages without the field degrade safely.

## [3.12.1] — 2026-07-03

Headline: the built-in F7 shortcut that launches Claude now works out of the box on a Mac, instead of doing nothing until you dug into macOS keyboard settings.

### Fixed

- **The default "launch Claude" shortcut works on macOS without touching system settings.** macOS treats F1–F12 as media keys by default, so a bare F7 press never reached wmux — the shipped F7 keybinding looked dead on a Mac. macOS now uses **Ctrl+F7** (a modifier makes macOS deliver it as a function key), while Windows and Linux keep the single-tap F7. Existing macOS users are migrated automatically on next launch: an untouched default F7 is upgraded to Ctrl+F7, but a keybinding you deliberately changed (different command) is left exactly as-is.

### Added

- **Custom-keybinding settings warn when a bare F-key won't fire on macOS.** If you bind a lone F-key (like F7) on a Mac, the settings panel now explains that macOS is intercepting it as a media key and how to reach it (hold Fn, or turn on "Use F1, F2, etc. keys as standard function keys"). The hint only appears for bare F-keys — a modifier combo like Ctrl+F7 is left alone because it already works.

## [3.12.0] — 2026-07-02 — Sessions survive a reboot

Headline: panes that were mid-conversation before an OS reboot now come back exactly as they were — same session id, same scrollback, same permission mode — instead of resetting to a blank terminal. Alongside that, an opt-in unattended supervisor lets a trusted pane restart itself after a crash and, with explicit consent, resume without stalling at a permission prompt.

### Added

- **Unattended supervisor: opt-in crash restart + consent-gated permission restore.** A layout leaf can declare `unattended: true` in `wmux.json`, which restarts it on failure (a clean exit is treated as "task finished," not a crash to relaunch) and, only with a separate explicit consent given in the trust dialog, restores the permission mode it was running under before a restart. Fleet View surfaces each pane's supervision state — armed with a restart count, or a guard-tripped marker when the runaway guard stopped it.
- **Daemon liveness moves to a three-state probe.** Replaces the old "probe failed → assume dead" pattern (the same anti-pattern behind earlier false-death and duplicate-daemon reports) with an explicit unknown/alive/dead classification, shared between the daemon and the launcher, so a slow OS probe can no longer make one daemon reclaim another live daemon's lock.

### Fixed

- **Terminal sessions survive an OS reboot instead of resetting.** Windows kills the daemon's PTY children before the daemon itself during a shutdown/reboot, and the daemon couldn't tell that apart from a user typing `exit` — it tombstoned the session as dead, and recovery skips dead sessions, purging exactly the ones that were in use. The daemon now recognizes the Windows shutdown-teardown exit code and suspends those sessions instead, so recovery replays them under the same id after reboot.
- **session.json no longer loses the latest layout on shutdown.** The Windows session-end handler used to reload the on-disk snapshot and save it straight back, which never captured the renderer's newest layout. Session data is now persisted the instant a pane's terminal id changes (not just every 5 seconds), so a reboot can no longer land in the gap between a new pane and the next periodic save.
- **A recovered session's scrollback replay no longer dismisses its own resume prompt.** Replaying a dead agent's buffered output could re-arm mouse tracking in the terminal, so simply moving the mouse toward the "resume" prompt looked like the user typing and silently dismissed it. Leaked input-reporting modes are now reset after a replay.
- **Claude Code's permission mode is read reliably from long transcripts.** The extractor only recognized permission-mode stamps on user turns, which a large attachment record could push out of the read window; it now also recognizes the dedicated permission-mode record Claude Code writes near the end of every prompt.

## [3.11.1] — 2026-06-29

### Fixed

- **Copy from full-screen TUI apps reaches the clipboard (OSC 52) ([#314](https://github.com/openwong2kim/wmux/pull/314)).** Full-screen TUI apps (Claude Code, vim, tmux, neovim) take over the mouse, so a drag no longer lands an xterm-native selection. On copy they emit an OSC 52 escape asking the terminal to set the clipboard, but xterm disables OSC 52 by default and wmux never registered a handler. The app showed "copied" while the system clipboard never changed, which looked like a corporate clipboard lockdown. wmux now honors OSC 52 for writes (clipboard reads, clears, oversized, and malformed payloads are refused) and routes the text through the existing clipboard path.

## [3.11.0] — 2026-06-29 — Channels become a two-way agent surface

Headline: v3.10.0 gave channels a place a **human** can read; v3.11.0 closes the loop on the **agent** side. An agent can now *read* a channel instead of only posting into it, *discover* and join public rooms, *invite* another workspace into a private one, and get *pulled in by an @-mention* that arrives as an inbox task and a one-line nudge in its terminal. The conversation view grows up alongside: markdown rendering, a scrollback window that pages older history in from the daemon, and in-channel search. Plus more accurate MCP agent identity and a batch of macOS keyboard and appearance fixes.

### Added

- **Channels become a two-way agent surface — read, discover, invite ([#305](https://github.com/openwong2kim/wmux/pull/305)).** Until now an agent could only *post* into a channel; it never saw what was already there. `channel_read` lets an agent pull a room's recent history (capped so it doesn't blow the context window), `channel_list` surfaces the public rooms it can *discover* and join, and `channel_invite` lets any member add another workspace — the only way into a private channel. The conversation view gains markdown rendering (with HTML injection stripped), a "load earlier" scrollback that pages older messages in from the daemon, and in-channel message search. Panes also self-name as `w<ws>-<pane>(<agent>)` so a roster of agents reads clearly, with a GUI rename.

- **@-mentions pull an agent into a channel ([#304](https://github.com/openwong2kim/wmux/pull/304), [#305](https://github.com/openwong2kim/wmux/pull/305)).** Typing `@` in the composer autocompletes the live agents in the channel; a mention of your workspace highlights the message, bumps a dock badge, and routes into the a2a task inbox. When the mentioned pane goes idle, a one-line nudge is pasted into its terminal pointing at `a2a_task_query` — so calling an agent in a channel actually reaches it instead of sitting unread.

- **Archive a channel from the header ([#302](https://github.com/openwong2kim/wmux/pull/302)).** A two-click arm-then-commit archive button in the conversation header, gated to the channel's creator (the daemon enforces the same authz).

- **MCP resolves agent identity by walking the process tree ([#301](https://github.com/openwong2kim/wmux/pull/301)).** The bundled MCP server identifies which workspace and pane a call came from by walking the caller's process tree to its owning PTY, so `a2a_whoami` and channel sender attribution work even when environment hints are stripped.

### Changed

- **Agent toolbar uses line icons instead of emoji ([#309](https://github.com/openwong2kim/wmux/pull/309)).** The per-agent toolbar swaps its emoji glyphs for consistent line icons that match the rest of the UI.

- **Channel roster shows added members and restores archive tooltips ([#303](https://github.com/openwong2kim/wmux/pull/303)).** An invited workspace now appears in the roster immediately, and the archive control's tooltips are back.

### Fixed

- **Ctrl+C copies the terminal selection even when the channel composer holds focus ([#311](https://github.com/openwong2kim/wmux/pull/311)).** With a channel open the composer could swallow the copy shortcut; the terminal selection now copies regardless of which surface holds focus.

- **macOS: Cmd drives clipboard, multiview, and shortcuts ([#307](https://github.com/openwong2kim/wmux/pull/307)).** Clipboard and multiview shortcuts now use Cmd on macOS instead of Ctrl, matching platform convention.

- **macOS: native button appearance stripped ([#308](https://github.com/openwong2kim/wmux/pull/308)).** Buttons no longer pick up the default macOS control styling that clashed with the app theme.

- **MCP recovers a pane's ptyId from `WMUX_PTY_ID` when the identity walk misses ([#299](https://github.com/openwong2kim/wmux/pull/299)).** A weak environment fallback restores pane identity when the process-tree walk can't resolve it, so same-workspace A2A still addresses the right pane.

## [3.10.1] — 2026-06-25

### Fixed

- **Channel dock and conversation no longer show raw i18n keys ([#297](https://github.com/openwong2kim/wmux/pull/297)).** The channels dock and the conversation view are pure presentational components that fell back to an identity translator when one wasn't passed in, surfacing raw keys (`CHANNELS.TITLE`, the empty-state message) instead of translated copy. They now receive the live translator, so the dock header, empty state, and labels render correctly.

## [3.10.0] — 2026-06-24 — Channels grow a human UI

Headline: the A2A channels that agents post into now have a **place a human can read and join.** v3.9.0 made channels multi-party with a server-verified sender; this release gives them a UI — a collapsible **right-side dock** that sits beside your terminals, a **member roster** to see who's in a room and join or leave it, and **recent history that loads when you open a channel** instead of a blank pane. Alongside the channel UI: copy/paste that survives a CJK IME, live channel delivery that survives a daemon reconnect, and a fail-closed gate on private-channel joins.

### Added

- **Channels move into a right-side dock you can read beside your terminals ([#287](https://github.com/openwong2kim/wmux/pull/287)).** A2A channels were agent-only plumbing; now there's a place for a human to watch and join them. The channel list and the active conversation live in a collapsible dock on the opposite edge from the workspace sidebar — a flex column that *reflows* the panes instead of the old overlay that floated over them, so opening a channel narrows the terminals rather than covering them. Toggle it from the StatusBar `#`, and it persists across restart. Decoupled from in-app Company mode, so it works without setting up a company first.

- **Channel member roster — see who's in a room, join and leave ([#291](https://github.com/openwong2kim/wmux/pull/291)).** The conversation header shows a member count that opens a roster popover: the workspaces currently in the channel, a self-only leave (the ✕ next to your own row), and an add-a-workspace picker for public channels. Fully keyboard-accessible — no drag-only paths. Leaving the channel you're viewing returns you to the list.

- **Opening a channel loads its recent history ([#293](https://github.com/openwong2kim/wmux/pull/293)).** Channels used to stay blank until a new message arrived in the current session — open a room with a backlog and you'd see nothing. Opening a channel now hydrates its recent messages from the daemon, and a daemon reconnect re-hydrates, so the conversation is there when you look.

- **Pane + surface lifecycle as MCP tools ([#285](https://github.com/openwong2kim/wmux/issues/285)).** Five new first-class MCP tools — `pane_split`, `pane_close`, `pane_focus`, `surface_new`, `surface_close` — so an external/headless orchestrator (e.g. a Claude Code supervisor that spawns a worker pane per task and reaps it once committed) can manage its panes through the official MCP instead of dropping down to the raw daemon JSON-RPC. They mirror the workspace-scoped lifecycle RPCs hardened in the #236 family (#238/#256/#257): the create tools (`pane_split`/`surface_new`) take an optional `workspaceId` and default to the caller's *own* workspace (never the on-screen one), failing closed on an explicit unknown id; the address tools (`pane_close`/`pane_focus`/`surface_close`) take a globally-unique id resolved across all workspaces, and `pane_focus` is non-yank (it won't steal the user's screen). No new daemon RPC or capability — the methods existed; this surfaces them and grants them to the bundled MCP server's first-party allowlist. Requested by @zhenzoo.

### Changed

- **Channel dock polish — one header, responsive width ([#295](https://github.com/openwong2kim/wmux/pull/295)).** The dock shipped with a duplicate "Channels" title (its own header plus the list panel's section header) and a hard 320px width that crushed the terminals to per-character wrapping on narrow windows. The title now renders once with the collapse control merged into it, and the width clamps (248–320px) so the dock yields space when the window is small and grows back when there's room.

### Fixed

- **Private channels are join-gated on the daemon ([#292](https://github.com/openwong2kim/wmux/pull/292)).** A same-machine caller that knew a private channel's id could join it directly through the daemon and read its history — `join()` had no visibility check. It now fails closed: a non-member can't join (or read) a private channel it wasn't invited to. Same-machine, same-user only; never remotely reachable.

- **Live channel delivery survives a daemon reconnect ([#290](https://github.com/openwong2kim/wmux/pull/290)).** A leaked `rpc:invoke` handler registration meant that after the daemon respawned or reconnected, the main process stopped teeing channel messages (and other daemon→main events) to the renderer until a manual reload — so a channel only updated when you reopened it. The handler is now removed correctly on reconnect, so messages keep flowing live.

- **Copy and paste survive a CJK IME ([#294](https://github.com/openwong2kim/wmux/pull/294)).** With a Korean/Japanese/Chinese IME mid-composition, the key event reports `keyCode` 229 / `key` "Process", so Ctrl+C and Ctrl+V silently did nothing while composing. wmux now falls back to the physical key code (`KeyC`/`KeyV`), so copy and paste work regardless of IME state.

## [3.9.0] — 2026-06-23 — Agent channels, with a verified sender on every message

Headline: **A2A channels** grow up. The multi-party half (U2) lands, so several agents in one workspace can talk in a shared, named room instead of only the one-to-one task messages A2A started with — and every channel message now carries a **server-verified sender** an agent cannot forge. Building on the channel domain types and persistence from U1 ([#269](https://github.com/openwong2kim/wmux/pull/269)), agents create, join, leave, post, and archive channels; the daemon pins each message's sender, each membership, and each channel's authorship to a workspace identity that the main process resolves from the *actual sending pane* rather than trusting a tag the caller put on the wire. A forged `verifiedWorkspaceId` is rejected outright — never attributed to the workspace it tried to impersonate — and private channels stay readable only to their members. Alongside it, the bundled CLI takes a stable identity so the legacy permission grandfather can start closing.

### Added

- **A2A channels — multi-party rooms with a server-verified sender (U2 + D5, [#280](https://github.com/openwong2kim/wmux/pull/280)).** Channels are Slack-style rooms for the agents in a workspace: a shared, named thread several agents post into, rather than the one-to-one task messages A2A began with. This release lands the multi-party operations on top of U1's domain types and persistence ([#269](https://github.com/openwong2kim/wmux/pull/269)) — create, join, leave, post, and archive — and makes **caller identity server-verified** end to end. Every mutating channel call is stamped with the workspace identity the main process resolves from the sender's real pane (`senderPtyId`), not a `verifiedWorkspaceId` the caller supplied:
  - the daemon's `ChannelService` pins the sender on each post, the member on each join/leave, and `createdBy` on each channel to that resolved identity, so a forged sender, member, or author is impossible;
  - the main process strips any client-supplied workspace tag and re-derives it from the owning pane, failing closed on a mutating call it can't attribute;
  - a forged `verifiedWorkspaceId` aimed at another workspace is **rejected**, never silently attributed to the victim;
  - channel reads are membership-scoped, so a non-member can't read a private channel's messages, and message bodies are length-clamped so an oversized post can't stall the pipe.

  Channel access stays gated behind the existing `a2a.channel.read` / `a2a.channel.send` capabilities, so this widens no trust boundary. Channels contributed by @AnandSundar; the verified caller-identity hardening (D5) by the wmux team.

### Changed

- **The bundled `wmux` CLI now reports a stable client identity, so the legacy permission grandfather can begin closing ([#282](https://github.com/openwong2kim/wmux/pull/282)).** The permission enforcer historically let any caller that sent no client name through unchecked (`if (!clientName) allow`) — a grandfather clause the bundled CLI, the one steady-state envelope-less caller, rode on. The CLI now identifies itself as `wmux-cli`, and the enforcer grants that identity *exactly* the narrow set of methods the CLI actually calls — a separate, tighter allowlist than the bundled MCP's first-party set, pinned by a source-level test so a new CLI command can't silently fall outside it. This is **additive**: nothing changes for callers today and the grandfather still admits envelope-less callers — it's the groundwork for a later release to close that grandfather behind the existing `enforcementMode` shadow→enforce switch.

## [3.8.0] — 2026-06-22 — LanLink: local-first cross-PC agent messaging

Headline: **LanLink** lets two wmux machines on the same LAN pair once with a 6-digit PIN, then exchange read-only agent messages over an authenticated, encrypted channel — no cloud, no account, off by default. The epic is built so that **running commands across machines is physically impossible**: the background daemon imports none of the agent-spawning code, a remote message can only ever surface as a read-only card in the renderer (never pasted into a terminal), and every internal RPC now carries a required trust-origin so the execute path fails closed for anything not provably local. Also lands A2A channels U1 (the rooms half of a future cross-PC group chat), a Fleet View sort toggle, a quieter zoom-restore button, and a keyboard-focus self-heal.

### Added

- **LanLink — local-first cross-PC agent messaging, off by default.** Two machines on the same LAN pair with a 6-digit PIN and then exchange read-only text messages over a ChaCha20-Poly1305 channel with per-connection fresh keys. Built across five PRs, with execute excluded by construction at every layer:
  - **Durable inbox + cursor-pull delivery ([#271](https://github.com/openwong2kim/wmux/pull/271)).** A daemon-side append-only inbox persists inbound remote messages and survives a renderer or main crash; the renderer pulls by cursor on reconnect, so nothing is lost and nothing replays twice. A dedicated IPC channel keeps a remote message structurally unable to reach the terminal-paste path.
  - **Control plane + Settings ([#272](https://github.com/openwong2kim/wmux/pull/272)).** An enable toggle and NIC picker in Settings, config persisted across daemon restarts, with the NIC stored as a name+MAC identity (re-resolved to a live IP at bind time, never a stale address). No listener yet — this is the network-0 control surface.
  - **LanLinkServer core ([#273](https://github.com/openwong2kim/wmux/pull/273)).** The network surface: an isolated `net.Server` bound only to a real external IPv4 on the chosen NIC (fail-closed bind guard, Windows Private-profile firewall), PIN-EKE pairing (X25519 + scrypt over the PIN, which never travels on the wire; ≤2-minute window; fail-burn after 5 wrong attempts), the AEAD channel, an allow-list router that admits only text/state messages (never execute/spawn), an ingress sanitizer, and a fail-closed per-peer store with live revoke. Per-peer random UUIDs and long-term secrets under an owner-only DACL.
  - **Renderer + pairing UX ([#275](https://github.com/openwong2kim/wmux/pull/275)).** A read-only **remote-peer card** in a new Fleet View *Remote* tab — untrusted off-machine text rendered as plain React text, never a terminal escape — plus a Settings **pairing section** (generate a PIN with a live countdown, join another machine, list and revoke peers), and the main-process bridge that exposes the daemon's pairing RPCs to the UI with the daemon itself untouched.
  - **Review follow-ups.** The pairing screen shows this machine's `host:port` next to the PIN so a peer can join from one screen ([#277](https://github.com/openwong2kim/wmux/pull/277)).

- **A2A channels — domain types + persistence (U1, [#269](https://github.com/openwong2kim/wmux/pull/269)).** The first half of channels — Slack-style rooms for agents: the channel domain types and a durable persistence layer, contributed by @AnandSundar. Converges with LanLink at a shared delivery seam toward a local-first cross-PC group chat.

- **Fleet View situational sort toggle ([#268](https://github.com/openwong2kim/wmux/pull/268)).** The cockpit grid can now toggle between attention-first (blocked agents float to the top) and pure workspace order.

### Changed

- **The A2A execute path is hardened against off-machine callers ([#270](https://github.com/openwong2kim/wmux/pull/270)).** Every internal RPC now carries a required trust-origin tag (`local` vs `remote`), and the agent-spawning `a2a.task.send` path only runs when the call provably came from this machine — a positive-allow gate that fails closed for anything else, pinned by a source-level test that the background daemon can never even import the code that spawns agents. Nothing changes for same-machine multi-agent use; this is the foundation that makes cross-PC execute impossible.
- **`system.capabilities` advertises only methods that are actually callable over the wire ([#276](https://github.com/openwong2kim/wmux/pull/276)).** Control-pipe-only RPCs (`daemon.*`, `lanlink.*`) are dispatched by the daemon pipe and never registered on the RPC router, so they're no longer listed — a wire client gets an honest capability list instead of methods that would just return unknown-method.
- **The zoom restore button is now a quiet, minimal control that matches the maximize button ([#274](https://github.com/openwong2kim/wmux/pull/274)).** When a pane is zoomed, the toggle that returns it to the grid was a bold red `ZOOM` badge — reusing the cursor accent, a strong red in several themes. It's now styled identically to the hover-revealed `⤢` maximize button (neutral surface, subtle border) with a `⤡` restore glyph, so maximize and restore read as a matched pair. It still stays visible while zoomed so the way back out is always obvious ([#258](https://github.com/openwong2kim/wmux/pull/258) follow-up).

### Fixed

- **Self-heal orphaned keyboard focus ([#267](https://github.com/openwong2kim/wmux/pull/267)).** Closing an overlay (search, palette, notifications, toolbar) could drop DOM focus to `<body>`, leaving the terminal unable to receive input until you opened multiview. A central guard now detects orphaned focus and reasserts it onto the active pane, so input keeps working after any overlay closes.

### Documentation

- **The README foregrounds the A2A multi-agent moat ([#260](https://github.com/openwong2kim/wmux/pull/260))**, and the contributor onramp gained issue templates plus an honest i18n status ([#261](https://github.com/openwong2kim/wmux/pull/261)).

## [3.7.0] — 2026-06-20 — A2A execute approval hardened, and remote RPC that lands in the right workspace

Headline: the A2A execute gate — the path that lets a remote agent spawn a `bypassPermissions` Claude CLI in your workspace — is reworked into a renderer-driven approval flow with `execute` as its own dedicated capability (no longer bundled with ordinary send), an `executeApproved` receipt the worker can't forge, fail-closed YOLO hydration, and a queue so concurrent requests don't clobber each other. Alongside it, the #236 RPC workspace-scoping sweep is finished: `surface.new`, `pane.close`, `pane.focus`, and `surface.focus` now all act on the workspace the caller names instead of whatever happens to be on screen — so a multi-agent orchestrator's "do this in MY workspace" finally lands where it should. Plus a per-pane activity line on Fleet View cards, and a browser-pane keyboard-focus fix.

### Added
- **Fleet View terminal cards now show a per-pane activity line — what each agent is doing right now, at zero extra API cost ([#251](https://github.com/openwong2kim/wmux/pull/251)).** wmux already receives a `PostToolUse` (`agent.activity`) hook payload for every tool an agent runs, and was discarding it at the emit-kind early-return. That payload is now summarized into a short, scannable line per pane — `✎ file` for an edit, `→ file` for a read, `$ cmd` for a bash run, `⌕ pattern` for a search, `srv:tool` for an MCP call — and rendered as an accent line on the pane's Fleet card, with the raw scrollback tail kept as the fallback when there's no activity (the `awaiting_input` affordance still takes priority). It's derived through a pure, never-throwing helper that guards every field of the untrusted tool input, strips control characters, caps the raw input at 1 KB before any regex runs (so a multi-megabyte tool argument can't stall the main thread), and hard-truncates the result to 80 chars; delivery is a per-pane 3-second leading-edge throttle on the existing metadata funnel — no EventBus tee, no notification, no new daemon round-trip. The activity string is transient and never persisted. Now a glance at the cockpit tells you not just *who is blocked* but *what everyone is doing*.
- **A2A execute approval is now a renderer-driven gate with `execute` as its own dedicated capability ([#254](https://github.com/openwong2kim/wmux/pull/254)).** The A2A execute path — `a2a_task_send` with `execute:true`, which spawns a `bypassPermissions` background Claude worker in the target workspace, i.e. remote code execution — was reworked into a stronger approval flow. `execute` is now a **separate capability** (`a2a.execute`) resolved per-call: a task send requires `a2a.execute` only when `execute:true` and the ordinary `a2a.send` otherwise, so granting an agent the ability to *message* you no longer implicitly grants it the ability to *run code* in your workspace. The worker is spawned only when the renderer returns `executeApproved===true` with a resolved target workspace — a receipt the caller cannot forge, replacing the old main-side confirm round-trip — and a denied request creates no task, pastes nothing, and emits no event. Concurrent execute requests are held in a keyed approval queue (each its own dialog, the inbox owning exactly one visible surface) so two agents asking at once can't clobber each other's prompt. A persisted "YOLO" auto-approve flag is available for trusted setups but **hydrates fail-closed** — only an explicit boolean `true` enables it, so a malformed persisted value (e.g. the string `"false"`) can never silently turn on `bypassPermissions` auto-approval — and the approval label is localized. Internal follow-up cleanup ([#255](https://github.com/openwong2kim/wmux/pull/255)) removed the now-dead confirm-execute plumbing and extracted the approval gate into a standalone, unit-tested module (YOLO short-circuit, approve, deny, 30 s auto-deny, and concurrent-request independence all covered).
- **A pane now has a discoverable maximize button ([#258](https://github.com/openwong2kim/wmux/pull/258)).** Hovering an un-zoomed pane reveals a quiet `⤢` button in its top-right corner; clicking it zooms that pane to fill the window — the same toggle as the tmux-style prefix + `z`, which was previously keyboard-only and undocumented. The keyboard cheat sheet (`?` in prefix mode) gained a **Maximize pane** entry. Surfaced after Reddit feedback that there was no visible fullscreen/maximize control to find ([#182](https://github.com/openwong2kim/wmux/issues/182) follow-up).

### Fixed
- **The #236 RPC workspace-scoping sweep is complete — `surface.new`, `pane.close`, `pane.focus`, and `surface.focus` all act on the workspace the caller names, not the one on screen ([#256](https://github.com/openwong2kim/wmux/pull/256), [#257](https://github.com/openwong2kim/wmux/pull/257)).** After [#238](https://github.com/openwong2kim/wmux/pull/238) made `pane.split` honor an explicit `workspaceId`, its sibling RPCs still didn't, so a multi-agent orchestrator working in a background workspace couldn't reliably operate on its own panes. **`surface.new`** dropped all of its params main-side and pinned the renderer to the *active* workspace, so "open a terminal in my workspace" always landed in whichever workspace the user was viewing; it now forwards `workspaceId`/`shell`/`cwd`, honors the target, fails **closed** on an explicit-but-unknown id (no active-workspace fallback), and eager-spawns the PTY into the target workspace. **`pane.close`** is a new RPC (panes carry globally-unique ids, so it's resolved across all workspaces like `surface.close`, disposing every PTY under the pane), filling the gap that left a worker pane created via `pane.split` with no way to be cleaned up — and it rejects root/non-leaf targets, since closing the root pane is a no-op that would otherwise orphan live surfaces with dead PTYs. **`pane.focus`/`surface.focus`** acted only on the on-screen workspace — `pane.focus` silently no-op'd while returning a false `{ok:true}`, and `surface.focus` errored "not found" — so a background-workspace agent couldn't focus its own pane; a dedicated `focusPaneSurface` store action now resolves the workspace by explicit id (no self-search, no active fallback), rejects non-leaf panes, sets the active pane and surface in one transaction, emits `pane.focused` honestly for a background or multiview workspace (events stay workspace-scoped, no cross-workspace leak), and surfaces a real `{error}` on a miss instead of the false success. Bringing a workspace on-screen remains the separate, opt-in `workspace.focus` RPC — these handlers never yank the user's screen.
- **A browser pane now takes keyboard focus when its own pane is active, so typing into it works ([#252](https://github.com/openwong2kim/wmux/pull/252), [#253](https://github.com/openwong2kim/wmux/pull/253)).** The embedded browser webview wasn't being focused when its pane became active, so keystrokes had nowhere to land and the browser pane felt dead to the keyboard. The webview is now focused whenever its pane is the active one.
- **Ctrl+Enter now inserts a newline instead of submitting, inside in-pane TUIs like Claude Code and codex ([#258](https://github.com/openwong2kim/wmux/pull/258)).** xterm sends a bare carriage return for Ctrl+Enter — byte-identical to plain Enter — so a TUI couldn't tell the two apart and treated Ctrl+Enter as submit. wmux now emits a line feed for the Ctrl+Enter chord, matching the existing Shift+Enter and Ctrl+J newline keys. Surfaced after Reddit feedback.

## [3.6.0] — 2026-06-17 — A reply finds the exact agent that asked

Headline: same-workspace agents now reply to the *exact* pane that asked. A task's reply returns to its originating pane instead of the workspace's active one, same-workspace history finally tells the two agents apart (sender vs receiver, per pane), and a status update is restricted to the addressed pane — completing the pane-level multi-agent mesh that #239 and #242 began. Plus a fix for the terminal+browser split that blanked its unfocused side.

### Added
- **A2A symmetric reply — a reply returns to the exact pane that sent the task, and same-workspace history is told apart per pane (S-C2, [#248](https://github.com/openwong2kim/wmux/pull/248)).** Follow-up to same-workspace agent messaging ([#239](https://github.com/openwong2kim/wmux/pull/239)). The task address model was asymmetric: `to` carried a pane anchor ([#235](https://github.com/openwong2kim/wmux/pull/235)) but `from` did not — so a reply had no pane to return to (it fell back to the workspace's active pane, or was suppressed same-workspace), and same-workspace history role collapsed to `user` for both parties, making the two panes' messages indistinguishable. The hardening in [#242](https://github.com/openwong2kim/wmux/pull/242) already captured and validated the sender's pane id on the send path, then discarded it; persisting it into `metadata.from` opens three things with no new trust surface. **(1) Symmetric reply pinning** — a reply destined for the original sender now returns to that exact pane instead of the active-pane fallback, so a sender workspace running more than one agent gets the reply on the right pane (fail-closed if that pane has since closed — never a wrong-agent paste). **(2) Per-pane history role** — the role is computed from the caller's verified pane (`user` for the sender pane, `agent` for the receiver pane) instead of collapsing same-workspace. **(3) Pane-granular status authz** — a status update (`a2a_task_update`) on a pane-addressed task is restricted to the addressed receiver *pane*, not any pane in its workspace. A same-workspace reply is delivered as a one-line nudge to the addressed sibling — never a full-body paste into a live agent's prompt — and is suppressed entirely when it can't be proven a non-self target, so the [#239](https://github.com/openwong2kim/wmux/pull/239) self-loop guard is preserved. The headless `execute:true` worker (which carries no sender pane id) is never locked out: an absent caller pane always falls back to workspace-level authz. Cross-workspace delivery and role are unchanged.

### Fixed
- **Terminal + browser split no longer blanks the unfocused side ([#247](https://github.com/openwong2kim/wmux/pull/247)).** A pane holding both a terminal and a browser surface renders them in a side-by-side split, but each surface gated its visibility on the pane's single active-surface id — so focusing one side hid the other (`display:none`) and the unfocused pane went blank, toggling as you switched. Visibility is now decoupled from focus: both sides stay rendered, and the active-surface id only drives keyboard focus.

## [3.5.1] — 2026-06-17

### Fixed
- **`surface_list`/`pane_list` caller-scoping hardening ([#245](https://github.com/openwong2kim/wmux/pull/245)).** An omitted-workspace `surface_list`/`pane_list` now revalidates a stale cached workspace id after a re-mint (daemon respawn / session restore) and prefers a confirmed-external caller's pinned workspace over the UI-active fallback — so a fail-soft read reports the caller's own workspace instead of an empty list or whatever the user has focused. Follow-up to the codex review on [#242](https://github.com/openwong2kim/wmux/pull/242) ([#243](https://github.com/openwong2kim/wmux/issues/243)).

## [3.5.0] — 2026-06-17 — Multi-agent workspaces that talk to each other

Headline: a workspace full of agents that can finally coordinate. Same-workspace agents now message each other directly (#239), every pane is individually addressable (#235), and the identity layer is hardened (#242) so a message never loops into the wrong pane or silently routes to a duplicate-named workspace. The A2A task inbox moved onto the EventBus so cross-agent delivery no longer corrupts a live terminal (#232), and Fleet View gained a unified approval inbox to clear every blocked agent from one list (#234).

### Added
- **Same-workspace agent-to-agent messaging ([#239](https://github.com/openwong2kim/wmux/pull/239)).** Two agent panes in the *same* workspace can now message each other with `a2a_task_send` — previously hard-rejected as "cannot send to yourself". Addressed by pane/surface id; a true self-send (your own pane) and an ambiguous no-address send are still refused, and the cross-workspace fail-closed boundary is unchanged. The data-suffix that isolates a sandbox instance now propagates to child PTYs so an isolated instance never leaks onto the production pipe.
- **Multi-agent identity & addressing hardening ([#242](https://github.com/openwong2kim/wmux/pull/242)).** Closes the adjacent bug cluster that made a multi-agent workspace fragile. `terminal_send`/`terminal_send_key` now refuse an agent's own omitted-`ptyId` call instead of looping the paste into its own (or a non-deterministic sibling) pane. `a2a_whoami` answers per-pane — *which agent am I*, not the workspace's single aggregate label — so siblings are told apart. A duplicate workspace name is refused with both ids instead of silently routing to whichever came first. `surface_list`/`pane_list` report the caller's own workspace. A rejected A2A task transition explains the allowed next states. And a mis-propagated `WMUX_DATA_SUFFIX` fails loud instead of silently booting an isolated instance onto production data.
- **Pane-level A2A identity & addressing, plus multi-target MCP registration ([#235](https://github.com/openwong2kim/wmux/pull/235)).** A workspace running several agents exposes each pane as an individually addressable A2A target.
- **A2A task inbox on the EventBus — pollable cross-agent delivery that no longer corrupts a live terminal (S-C2 ②).** When one workspace's agent hands a task to another, the task is now teed onto the shared event ring, so the receiving agent can discover it by polling `wmux_events_poll` instead of having the message force-pasted into its terminal (which used to corrupt a running TUI's input box). The sender gets the status receipt — created → updated → cancelled — the same way. Delivery is strictly dual-party: only the two workspaces involved in a task ever see its events; a third workspace, and any workspace-less poll, see nothing. A receiver that is already running a live agent now gets a one-line nudge (a pointer to run `a2a_task_query`) instead of the full message body, so its prompt is never flooded — a receiver with no live agent still gets the full paste, so nothing regresses for peers that don't poll.
- **`a2a_discover` liveness hint (③).** Peers returned by `a2a_discover` now carry an advisory live/idle signal so an orchestrator can prefer an agent that is actually running. Advisory only — it never gates delivery.
- **Unified approval inbox in Fleet View — clear every blocked agent's out-of-band prompt from one keyboard-driven list (S-C2).** Fleet View's stubbed "Approvals" tab (`Ctrl+Shift+A`, then the Approvals tab) is now a single inbox of every approval currently holding the fleet hostage, each resolved through its own real path: MCP plugin permission prompts (an unconfirmed plugin requesting capabilities under enforce mode — several can stack at once, keyed distinctly, each row showing the declared capabilities with a per-row risk badge), and the A2A execute gate (a remote agent asking to spawn a `bypassPermissions` Claude CLI in your workspace, shown with its live 30-second auto-deny countdown and the sender→receiver context). Arrow to a row and press `Enter` to approve, `Backspace`/`Delete` to deny — except a row carrying a critical capability (e.g. terminal-content), which `Enter` will *never* grant: those require clicking the explicit Approve button, so scrolling a dense list can't blind-grant a dangerous permission. It's the same surface the old approval modal drove, kept in lock-step: resolving a prompt in the inbox or the modal clears it in the other, and a removal signal retires the row no matter how it was answered — through the old modal, by a coalesced sibling, or by a plugin disconnecting — so there are no phantom rows. While the Approvals tab is open it is the single surface (the modal is suppressed underneath it). Only the two out-of-band-resolvable sources appear here; an approval that can only be answered by typing into the pane stays jump-only rather than growing a dead Approve button.
- **Live output tail on Fleet View terminal cards.** Each terminal card now shows its pane's last ~3 output lines, so you can read what an agent is actually doing — and triage which blocked one to jump to first — without leaving the cockpit. It's a pure renderer derivation off state the store already holds (no new daemon traffic), and it works for background panes too — the ones rendered off-screen, which was the subtle part: a card for a pane you've never had on screen still shows its live tail.
- **`pane.split` honors an explicit `workspaceId` ([#238](https://github.com/openwong2kim/wmux/pull/238)).** A multi-agent orchestrator can split a specific (non-active) workspace's pane, with the new pane eagerly spawning its PTY rather than waiting to be focused.

### Fixed
- **Right-click paste yields to the app when it owns the mouse ([#241](https://github.com/openwong2kim/wmux/pull/241)).** A terminal app that has taken over the mouse (e.g. a TUI) now receives the right-click instead of having wmux intercept it for paste.

## [3.4.0] — 2026-06-15 — Fleet View, and Claude conversations that survive a reboot

Headline: two ways to lose less time on a multi-agent day. **Fleet View** is the cockpit — every agent across every workspace on one screen, the blocked ones floated to the top, one click to jump to where you are needed. And **X6 resume** closes the loop on reboot survival: a Claude pane no longer just comes back as a shell, it comes back offering to resume the *exact* conversation it was running — on every pane, not just the one you were watching, with the permission mode you had set. Plus an agent toolbar, and fixes for the Windows taskbar icon and the PowerShell 5.1 prompt hook. Thanks to [@matdac6](https://github.com/matdac6) (#228, #229) and [@snowyukitty](https://github.com/snowyukitty) (#227).

### Added
- **Fleet View — every agent across every workspace on one screen (S-C1).** Press `Ctrl+Shift+A` (or run "Open Fleet View" from the command palette) and the whole fleet snaps into one full-screen cockpit: a card for every pane across every workspace, sorted so the agents that want you float to the top. An agent paused mid-turn on a confirmation prompt — `awaiting_input`, the unattended-loop money state — sorts first, gets a yellow outline and a "needs your input" affordance, and a header chip tells you how many are waiting on you ("2 need you"). Idle terminals sink to the bottom and dim. Click a card — or arrow to it and press `Enter` — and you are there: it switches workspace, pane, and surface in one step and lands focus exactly where the agent is, reusing the same hardened jump the OS-toast notifications use (zoom coherence included). This is the screen you keep open while loops run unattended: walk away from six agents, glance once, jump straight to the blocked one.
- **Built as a pure derivation, not a new subsystem.** The grid reads state the renderer already holds — every workspace's full pane tree lives in the store — so there is no new daemon round-trip and no second copy of the truth to go stale; it reflects live agent status the moment the daemon detects it. Status resolves per-PTY first and scans *all* of a pane's tabs, so an agent waiting for you in a background tab is never silently shown as idle. The overlay traps keyboard focus (no stray keystrokes leak into the terminal underneath it) and is fully keyboard- and screen-reader-navigable (`role="dialog"`, roving `role="option"` cards). Output preview is status + workspace + path for now; a live output tail and the unified A2A + MCP approval inbox (the stubbed "Approvals" tab) are next.
- **`claude --resume <id>` after a reboot — the exact conversation, on every pane (X6 ③).** The resume pill now restarts the *exact* Claude session it was bound to (`claude --resume <session-id>`), with the permission mode you had set (so a `--dangerously-skip-permissions` workflow survives the reboot), instead of the cwd-relative `--continue` that could resume the wrong conversation when several panes share a directory. The binding — the pane's Claude conversation id, captured live from the hook — is persisted on the daemon session record and survives a hard SIGKILL. Crucially it works for *every* pane that ran Claude, not just the one whose startup banner the daemon happened to catch live: a captured hook now also lights the pill (so a pane whose banner was missed still offers a resume), each pane is attributed by its own daemon session id (so two panes in the same directory each resume their own conversation, never each other's), and a capture that couldn't reach the daemon at the moment it fired is spooled to disk and reconciled on the next boot. A purged transcript or a moved working directory degrades safely to `--continue` rather than a dead `--resume`.
- **A supervised agent pane resumes its conversation on restart and reboot (X6 ①).** When the daemon's pane supervisor (X8) re-creates a declared agent pane after a crash, a daemon restart, or a full reboot, it now relaunches the agent in *resume* form so the conversation continues where it left off, rather than starting a fresh agent in the same pane. The original launch command stays on the record; only the replay is rewritten, and the conversation binding is carried onto the recreated pane so a second crash before the next hook still resumes the exact session.
- **Agent toolbar — Attach, File explorer, Snippets, Rich Input, New** ([#228](https://github.com/openwong2kim/wmux/pull/228), thanks [@matdac6](https://github.com/matdac6)). A toolbar above the terminal with one-click access to attaching context, a file explorer, snippets, a rich-input composer, and opening a new pane.

### Fixed
- **The "Resume Claude" pill now survives a real reboot — even right after you start an agent.** A pane where you'd just typed `claude` could come back from an OS reboot with no resume pill. The daemon persisted the detected-agent marker (`lastDetectedAgent`) on a 30s debounce, and a real reboot is a hard SIGKILL — no graceful flush runs — so a reboot inside that window dropped the marker and recovery had nothing to offer. The single idle agent pane, exactly the reboot-survival headline case, was the one most likely to hit it. Agent detection now persists immediately (`saveImmediate`), bounded to one write per agent transition by the existing slug guard. The same gap affected live working-directory changes, and was strictly worse: the `session:cwd` handler persisted *nothing*, so a reboot could restore a pane to a stale directory and make the cwd-scoped `claude --continue` resume the wrong conversation. Working directory now persists immediately on an actual `cd` (guarded so a per-prompt OSC 7 re-report doesn't amplify writes). The previous offer dogfood seeded the marker straight into the snapshot, bypassing the detect→persist path entirely, which is why the race went unseen; a new kill-real dogfood drives real agent detection and then SIGKILLs the daemon inside the window to prove the fix end to end. A follow-on GUI dogfood then surfaced a **second, independent cause** on the renderer: even with the marker persisted and delivered to the renderer, a recovered pane's xterm focus-tracking report (`CSI I` / `CSI O`) arrives through `terminal.onData` on mount and was mistaken for the user typing, so `clearResumeHint` retracted the pill the instant it hydrated — meaning the pill had effectively never rendered after a reboot at all. Focus reports are now excluded from the retract path (real keys, pastes, and IME commits still retract as intended). Both fixes are required for the pill to actually appear.
- **The prompt hook now works on Windows PowerShell 5.1** ([#227](https://github.com/openwong2kim/wmux/pull/227), thanks [@snowyukitty](https://github.com/snowyukitty)). The OSC 7 / 7727 sequences that drive working-directory tracking and the prompt markers are now emitted with `[char]27`, which PowerShell 5.1 passes through correctly — previously the escape was mangled on 5.1, so the hook silently did nothing and cwd/branch tracking never updated on that shell.
- **The Windows taskbar icon is back** ([#229](https://github.com/openwong2kim/wmux/pull/229), thanks [@matdac6](https://github.com/matdac6)). The app icon had stopped rendering in the taskbar; `icon.ico` is now re-encoded with BMP frames so Windows draws it again.

## [3.3.0] — 2026-06-13 — supervised agent panes, 74% faster cold start, and a lighter idle footprint

Headline: a `wmux.json` pane can now declare a restart policy and the daemon supervises it like an init system — auto-restarted with backoff across process exits, daemon restarts, and full reboots, with a runaway guard so a crash-loop burns backoff instead of tokens (X8). Cold start is **74% faster** on the dev machine (5570 → 1176 ms; first contentful paint 5.2 → 0.65 s) after moving the auth-token ACL hardening off the boot critical path, loading the renderer in parallel with the daemon bootstrap, and adaptive readiness polling — with a new `wmux doctor` to diagnose a slow boot in one command. Plus a lighter idle footprint (lazy buffer allocation, visibility-gated metadata polling, pruned native prebuilds), a refined-terminal sidebar pass, and an awaiting-input signal for Claude Code's `AskUserQuestion` prompt. Thanks to [@matdac6](https://github.com/matdac6) for three contributions this cycle (#212, #218, #219).

### Added
- **wmux now signals when Claude Code is waiting on an `AskUserQuestion` prompt** ([#212](https://github.com/openwong2kim/wmux/pull/212), thanks [@matdac6](https://github.com/matdac6)). When Claude Code shows its multi-line boxed question UI inside a wmux pane, the pane's sidebar dot turns yellow and the awaiting-input sound fires — the same signal you already get for single-line approval prompts. Previously "awaiting input" was detected only by the regex `AgentDetector`, which is anchored to single-line prompts (`Do you want to proceed?`) and never matched the boxed `AskUserQuestion` layout, so a user who looked away got no cue that the agent was blocked on them. The fix is signal-based, not another regex: a `PreToolUse` hook scoped to the `AskUserQuestion` tool maps to the existing `awaiting_input` status (guarded on `tool_name` so a future broad matcher can't tunnel spurious signals). The dot clears automatically when you answer and the agent resumes. No new UI — it reuses the existing status, sound, and dot.
- **Cold-start boot-phase instrumentation (S-A).** The main process now emits one cheap `[boot-trace]` line per boot milestone (process spawn → module eval → app-ready → plugin load → daemon bootstrap with spawn/pipe/ping sub-phases → ready end), plus a JSON summary that lands in the daily log file; the daemon exposes its own boot marks through `daemon.ping`. The perf bench collects both and prints a derived phase-attribution table, so a cold-start regression now points at the guilty phase instead of a single opaque number. First run of the new table immediately attributed ~70% of the measured cold start to the auth-token ACL hardening's synchronous PowerShell shell-outs (one in the main process, one in the daemon) — the optimization target for the follow-up PR. Zero telemetry: stderr and local log files only.
- **`wmux doctor` — one-command diagnostics** ([#216](https://github.com/openwong2kim/wmux/pull/216)). A new CLI command that turns the boot-trace instrumentation into a user-facing health check: environment (version, pipes, auth token, data suffix, app-pipe reachability), daemon status over its **own** control pipe (pid, uptime, sessions, event-loop lag — diagnosable even when the main process is dead), the same boot-phase attribution table the perf bench prints (main + daemon-internal phases, parsed from the daily log's boot summary with a bounded tail read), an antivirus-tax hint when a cold-rescan phase exceeds 1.5 s, and today's error/warn counts for both log files. `--json` for scripts; exit 1 only when something actually failed. "wmux feels slow / won't start" reports can now begin with one command instead of log archaeology.
- **RAM attribution in the perf bench** ([#217](https://github.com/openwong2kim/wmux/pull/217)). The bench's flat RAM number now ships with a per-category breakdown (main / renderer / gpu / utility / daemon / conhost / user shells), a `--scrollback-lines` A/B seed, and a WebGL-context occupancy probe — all additive, nothing gated. First verdict from the data, recorded in `bench/README.md`: **about half the 8-pane footprint is the user's own shells**, the scrollback A/B delta on near-empty terminals is ~0 (xterm's buffer is lazily populated), and the GPU process is a single fixed cost — so the planned RAM-diet code work was cancelled by measurement before any code was written.
- **Pane supervision — the daemon keeps declared panes alive as exec-style units (X8).** A `wmux.json` pane can now declare `restart: on-failure | always` (with an optional `restartLimit`), and the daemon supervises that pane the way an init system supervises a service: when the process exits it is auto-restarted with exponential backoff, and a runaway guard halts supervision after N consecutive short-lived runs (it must be manually rearmed) so a tight crash-loop burns backoff instead of tokens. Because the supervisor is the daemon — which already survives app crashes and machine reboots — supervision is sticky: a supervised loop is restarted across daemon restarts and across a full reboot, so an unattended overnight loop comes back on its own after the machine cycles. Nothing supervises until you trust the file (same `wmux.json` trust gate); plain panes are unaffected.

### Changed
- **Cold start: the renderer now loads in parallel with the daemon bootstrap (S-A Step 1)** ([#215](https://github.com/openwong2kim/wmux/pull/215)) — **measured 1436 → 1176 ms (-18%) locally, 1441 → 989 ms (-31%) on CI; first contentful paint 1.08 s → 0.65 s.** Since the v2.13 first-keystroke race fix, the boot tail ran strictly serialized: wait for the daemon to spawn and connect, then start loading the renderer — stacking the two longest boot legs (~625 ms renderer, ~464 ms daemon bootstrap) back to back, with the window sitting on a blank background frame the whole time. The bootstrap is now kicked without awaiting and the renderer loads immediately, so the daemon spawn hides behind the renderer load. The race that forced the serialization (a renderer mounting mid handler-swap could mint a local-mode pty id and have its writes silently dropped — "first keystroke doesn't register" on fresh installs) is closed structurally rather than by ordering: the renderer's first ready-state query parks until the daemon-vs-local decision is final, and the pane gate keeps every terminal-create path shut until the startup reconcile completes. The one listener those defenses didn't cover (the late-reconcile trigger on `daemon:connected`, which previously could not fire before the renderer existed) is now gated on the pane gate, extracted, and unit-tested. Verified against the original regression scenario: 10/10 isolated cold boots with a keystroke fired the instant the terminal mounts, zero drops.
- **Cold start: adaptive daemon readiness polling (S-A C1)** ([#214](https://github.com/openwong2kim/wmux/pull/214)). After spawning the daemon, the launcher polled for readiness on a fixed 200 ms interval — boot traces showed ~93–199 ms of pure poll quantization between "daemon wrote its pipe file" and "launcher noticed" on every cold start. The poll is now an immediate first check followed by a 40 ms cadence for the first 2 s, backing off to the original 200 ms for slow-machine tails; the same span now measures 6–44 ms per cold run. The zombie-pipe guard, auth-token gate, 15 s budget, and the already-running-daemon yield path are preserved, and the loop is extracted behind a dependency-injected helper with fake-timer tests (it previously had none).
- **Cold start: auth-token ACL hardening moved off the boot critical path (S-A) — measured 5570ms → 1436ms (-74%) on the dev machine, first contentful paint 5.2s → 1.1s.** The boot traces attributed ~70% of cold start to the token-file ACL hardening's synchronous whoami + PowerShell shell-outs — once in the main process (PipeServer constructor, 2015ms median) and once in the daemon (3465ms, directly on the path the launcher polls). Three changes, none of which weaken the hardening guarantees:
  - **Re-hardening an existing token is now deferred and fully asynchronous.** The token VALUE doesn't change on re-harden, so an attacker who could exploit the brief deferred window could equally have read the file at any point of its prior on-disk lifetime under the same ACL — and the RPC surface is protected by the token value (timing-safe compare), not by the file ACL. The deferred path uses async `execFile`/`spawn` exclusively, so the multi-second shell-out can no longer stall the daemon's event loop either. Verified to converge to the same owner-only DACL (including removal of explicit `Everyone` ACEs) by the extended `scripts/issue-124-acl-dynamic.mjs` harness.
  - **Freshly created token files are hardened via icacls (~120ms) instead of PowerShell (~1-2s).** The #124 objection to icacls — it cannot remove a pre-existing explicit broad ACE — is unreachable on a file that did not exist before the write (it carries only inherited ACEs, which `/inheritance:r` strips). Overwrites of an existing file (token rotation, empty-file repair) keep the PowerShell-first DACL rebuild. Fail-closed semantics unchanged: if both primitives fail, the un-hardenable token is deleted and the write throws.
  - **McpRegistrar no longer rewrites an identical token file** at the end of the ready handler (the PipeServer constructor had just written the same value through the same secure path).
- **Lighter idle/background footprint — RAM, CPU, and package size** ([#219](https://github.com/openwong2kim/wmux/pull/219), thanks [@matdac6](https://github.com/matdac6)). Three independent reductions, all transparent to consumers: the daemon's per-session `RingBuffer` now allocates 64 KB up front and doubles toward the configured ceiling (default 8 MB) on demand instead of committing the full ceiling per session — idle/quiet sessions hold ~64 KB, chatty ones still grow to the ceiling with no scrollback lost; the 5 s per-PTY metadata poll (git / `gh` / `/proc` work that only feeds cosmetic UI) is now gated on `shouldPollMetadata()` and skipped while the window is destroyed, loading, hidden, or minimized, with the next visible tick refreshing within ≤5 s so staleness stays bounded; and `postPackage` prunes the non-target `node-pty` prebuilds (the win32-x64/arm64 ConPTY binaries are ~30 MB each), reclaiming ~28 MB+ per build across both node-pty copies, while defensively keeping everything if the target dir is missing.
- **Refined-terminal sidebar aesthetics** ([#218](https://github.com/openwong2kim/wmux/pull/218), thanks [@matdac6](https://github.com/matdac6)). A visual pass over the sidebar: the glyph icons (`⚙ ⧉ ✕ ▸`) across workspace rows, the mini-sidebar, and settings are replaced by a shared stroke-icon SVG module (`icons.tsx`) so every control scales crisply; the agent-status indicator now routes through `AGENT_STATUS_ICON`'s `dotVar`/`glowClass`/`mark` fields as a colored status dot with an animated glow plus a right-aligned play/pause mark; and token-derived depth, softened popover borders (`rounded-lg` + `color-mix`), row/popover enter animations, and a shared focus-ring helper round it out — every motion effect gated behind `prefers-reduced-motion`. Spec and plan under `docs/superpowers/`.

### Fixed
- **Token ACL hardening silently degraded to icacls when wmux was launched from PowerShell 7 (Store install).** The inherited `PSModulePath` leads with pwsh 7's Core-edition Modules directory, so the Windows PowerShell 5.1 child failed to auto-load its own `Microsoft.PowerShell.Management`/`Security` modules (`CommandNotFoundException` on `Get-Item`), and the #124 DACL rebuild — the only primitive that removes pre-existing explicit broad ACEs — never ran, falling back to icacls on every boot. The 5.1 child now gets `PSModulePath` stripped from its environment so it reconstructs its own default module path regardless of which shell spawned wmux. Found via the new boot traces: the measured "hardening cost" on a pwsh7-launched dev box was actually a failing PowerShell plus the fallback.

### Contributors
- **[@matdac6](https://github.com/matdac6)** — three contributions this cycle, on top of the workspace Rename context-menu item (#184): the `AskUserQuestion` awaiting-input notification ([#212](https://github.com/openwong2kim/wmux/pull/212)) — a clean signal-based fix with a root-cause writeup, a `tool_name` guard against spurious signals, and tests on the wmux side; the refined-terminal sidebar aesthetics pass ([#218](https://github.com/openwong2kim/wmux/pull/218)); and the lighter idle footprint across RAM, CPU, and package size ([#219](https://github.com/openwong2kim/wmux/pull/219)). Thank you!

## [3.2.0] — 2026-06-12 — wmux CLI on your PATH, wmux.json project config, click-to-jump notifications, perf gate

Headline: every shell — inside or outside wmux — gets a `wmux` command with verified self-pane identity; a repo-root `wmux.json` turns "open this repo" into a fully arranged workspace (custom commands + declarative pane layout) behind a byte-exact trust gate; clicking a desktop toast now jumps straight to the pane that fired it; and a benchmark harness with a CI regression gate puts real numbers behind the performance story (echo p95 29.2 ms, no degradation at 8 panes). Plus cross-workspace browser-close routing, a multi-image paste fix, and Smart App Control install guidance.

### Added
- **Clicking an OS toast now jumps to the pane that fired it (X2).** Desktop notifications — agent turn-ends, OSC 9/777/99 terminal notifications, process-exit errors, and external `wmux notify` calls — carry their originating pane context. Clicking the toast restores and focuses the window, switches to the owning workspace, activates the pane and the exact surface (tab) that produced the notification, marks its unread notifications read, and clears the attention ring. Toasts from `wmux notify --workspace <id>` jump to that workspace; if the source terminal closed between toast and click, the click degrades to the old focus-the-window behavior.
- **`wmux setup-hooks` — install Claude Code hooks without the marketplace plugin.** The plugin-less path to the deterministic agent-signal bridge: `wmux setup-hooks` installs the same 4 hook entries (`Stop`, `SubagentStop`, `SessionStart`, `PostToolUse`) directly into Claude Code's user settings (`~/.claude/settings.json`) and copies the bridge to a stable, update-proof location (`~/.wmux/hooks/wmux-bridge.mjs`) that the settings reference — never the versioned install dir, so it survives app updates. The merge is idempotent and surgical: it preserves all your existing hooks and every other settings key, and a corrupted settings.json aborts rather than clobbering your config. `--status` reports which events are wired, whether the copied bridge is stale (byte-compared against the bundled source), and warns if the marketplace plugin is *also* installed (which would double-fire signals); `--remove` deletes only the wmux-owned entries.
- **A1 performance benchmark harness + CI perf gate.** `scripts/perf-bench.mjs` measures what users feel against the packaged app: input latency (key→echo and key→frame, instrumented inside the renderer so CDP transport never pollutes the numbers; at 1 pane and 8 panes), cold-start milestones (spawn → pipe ready → renderer → first PTY data), and full-process-tree RAM including the detached daemon. Each run spawns the app in an isolated data namespace (`WMUX_DATA_SUFFIX`), so it can run alongside a live wmux, and shuts the daemon down cleanly afterwards. `scripts/perf-compare.mjs` gates regressions against blessed baselines (double-condition: ratio AND absolute margin) and `.github/workflows/perf.yml` runs the gate on PRs and appends a trend line to `bench/history.ndjson` on main. First measured numbers on the dev machine (i5-13420H): echo p95 29.2 ms, key→frame p95 44.1 ms, with no measurable degradation at 8 panes — baselines are descriptive measurements, never aspirational targets. See `bench/README.md`.
- **Project configuration via `wmux.json` (X5).** Drop a `wmux.json` at your repo root and wmux turns it into a per-project workspace: **custom commands** (`{"id": "dev", "title": "Dev server", "command": "npm run dev"}`) appear in the command palette and the sidebar's project dialog, and a **declarative pane layout** (nested `panes` with per-pane startup `command`, project-relative `cwd`, or a `url` for an embedded browser pane) is applied automatically when you open a fresh workspace in that repo — "open this repo → Claude Code + dev server + browser, arranged" with zero clicks. Discovery walks up from the workspace's live cwd and stops at the repo boundary. **Nothing executes until you trust the file**: wmux.json is checked into the repo, so the first discovery only *displays* — a review dialog shows every shell command verbatim, and the trust grant is bound to a hash of the exact bytes reviewed. Any later edit (e.g. a malicious PR changing a command) demotes the project to display-only until re-approved; "deny" is sticky until explicitly cleared.
- **`wmux` CLI on your PATH, with verified self-pane identity (X4).** The installer now drops a `wmux` command onto the user PATH (regenerated on every update, removed on uninstall), so any shell — inside or outside wmux — can script the app: `wmux send "npm test" --submit`, `wmux read-screen`, `wmux notify "Done" "Build finished"`, `wmux open http://localhost:3000`, `wmux split`, `wmux list-workspaces --json`. Run inside a wmux pane, terminal commands target **the pane you typed them in** — identity is resolved by walking the CLI's own process tree against the PID map (the same verified identity the MCP terminal tools use, never the spoofable/stale env hint), and the zero-spawn fast path covers the common shell-direct case. `--pane <ptyId>` targets another pane explicitly, `--active` keeps the old UI-focused-pane behavior, and notifications/browser opens route to the calling workspace automatically. The CLI client also gained the TCP-localhost fallback for Windows named-pipe ACL edge cases.

### Documentation
- **Smart App Control (SAC) install guidance** (#200, reported with a full diagnostic timeline by @alphabeen). On Windows 11 devices with SAC enforcing, the unsigned installer can be blocked outright — no SmartScreen dialog, no "Run anyway" — and the block can be transient (cloud reputation): the same binary may install successfully hours later with zero local changes. README (install section + FAQ) and `install.ps1` now explain how to confirm SAC is the cause (`Get-MpComputerStatus | Select-Object SmartAppControlState`, Code Integrity Event ID 3077) and the workarounds: winget/Chocolatey, retry later, or build from source.

### Changed
- **`a2a.resolve.identity` now returns pane-level `entries`** (`pid` + `ptyId` + `workspaceId`) alongside the existing `mappings` — additive; existing MCP clients are unaffected.

### Fixed
- **Pasting multiple images in a row no longer invalidates the earlier ones** (#201). Each image paste deleted the previous `wmux-paste` temp file, so pasting several screenshots into Claude Code left only the most recent path readable. Temp files now survive the session (a startup sweep removes stale ones older than 24h) and get a random suffix so rapid pastes can't collide.
- **`browser_close` / `wmux browser close` can no longer tear down a browser pane the user is viewing in another workspace.** `browser.open` was pinned to the caller's workspace in #193, but `browser.close` kept resolving "the browser pane" inside the UI-active workspace — an agent in workspace A issuing a close took down whatever browser the user happened to be looking at in workspace B, or got a spurious "not found" when B had none. Close now routes the same way open does: MCP resolves the calling workspace (fail-closed), the CLI uses its verified self-pane identity (with a `--workspace` override), and an explicit `surfaceId` — which is globally unique — is found across all workspaces. `surface.close` with an explicit id likewise no longer fails with "surface not found" when the surface lives outside the active workspace. Callers that pass no workspace at all keep the active-workspace behavior.

### Contributors
- **[@alphabeen](https://github.com/alphabeen)** — Smart App Control installation investigation ([#200](https://github.com/openwong2kim/wmux/issues/200)): a complete diagnostic timeline (registry state, Code Integrity 3077 events, the transient cloud-reputation behavior, and why v2.x was unaffected) that became the new SAC install guidance verbatim. Exemplary report — thank you!

## [3.1.1] — 2026-06-12 — browser pane wired into the workflow, IME input self-healing

Headline: the embedded browser pane is now reachable from where you actually work — terminal URLs route smartly, sidebar port badges open localhost in one click, and browser panes restore on the page you last visited. And the field-reported "keyboard input dies until you toggle multiview" IME failure on Korean Windows now self-heals: the suspect textarea-clearing is off by default and a storm guard detects the dead-input signature and resyncs the IME automatically.

### Added
- **The embedded browser pane is now wired into the terminal workflow (X3).** Clicking a URL printed in a terminal routes smartly: localhost / 127.0.0.1 URLs open in the workspace's embedded browser pane (reusing the existing pane and navigating it), external URLs open in the system browser, and Ctrl/Cmd+click inverts the choice. The sidebar's listening-port badges (X1) are now clickable — one click shows `http://localhost:<port>` in that workspace's browser pane, un-zooming any pane that would hide it. `target="_blank"` links inside the browser pane now work and open in the same pane (popup windows stay blocked). `Ctrl+Shift+L` and the palette's "Open Browser" keep their always-create-a-new-pane behavior.
- **Browser panes restore on the page you last visited.** Every navigation — toolbar, in-page links, agent-driven CDP navigations alike — is persisted per surface, so a session restore reopens each browser pane on its last URL instead of the one it was created with.

### Fixed
- **Keyboard input no longer dies until the terminal is remounted (Korean/CJK IME "claim storm").** Field report on v3.0.0: typing and arrow keys stopped reaching the terminal — clicking didn't help, only forcing multiview on and off (which remounts the terminal) recovered it. Mechanism: when the Windows IME's state desyncs from xterm's hidden textarea, it claims every keydown (`keyCode 229`) and xterm drops all of them. Two-part fix: (1) the v3.0.0 idle IME-textarea clearing (#167 protection for field-replacing voice injectors) is now **off by default** — its programmatic wipe of the IME-owned textarea is the prime suspect for the desync; it remains available under Settings → Terminal for AutoGLM-style tool users. (2) A new always-on storm guard detects the claim-storm signature (consecutive 229 keydowns across distinct keys with zero composition activity) and resyncs the IME with a blur/refocus — the remount cure, automated — surfacing a toast and a console diagnostic so the trigger can be confirmed in the field.
- **Session restore no longer leaves keyboard focus on nothing.** Restored terminals register for focus only after their async scrollback load, but the focus driver gave up after ~10 animation frames and the boot-time focus target never changes again — so on slower restores the app came up with DOM focus on `<body>` (typing went nowhere until a pane/workspace switch). Terminal registration now pushes a notification the focus driver subscribes to, one-shot, so late registrations still receive focus and later re-registrations can't steal it.
- **`browser.open` on an existing browser surface now actually navigates the webview.** The reuse path only rewrote store state, which the mounted webview never re-reads — the MCP call reported success while the page stayed put.
- **`browser.open` no longer resets an unspecified partition to the default.** The forced reset remounted the webview (the partition is part of its render key) and dropped the login session.

## [3.1.0] — 2026-06-12 — UI plugin host, workspace context sidebar, terminal notifications

Headline: wmux panes and sidebars are now extensible by third-party UI plugins running in sandboxed iframes under the same permission stack as MCP plugins; the workspace sidebar shows live zero-config context (git branch, PR status, process-scoped listening ports, latest notification); and standard terminal notification escape sequences (OSC 9/777/99) are parsed into first-class events. Plus a batch of rendering and MCP-routing fixes. All features dogfood-verified on a live build.

### Added
- **Workspace context sidebar (X1): live git branch, PR status, scoped listening ports, and latest notification per workspace — zero config.** The sidebar now shows each workspace's git branch via an `fs.watch` on `.git/HEAD` (no polling; linked worktrees detected and marked), the current branch's PR number/state/CI checks from a 5-minute `gh` cache (silently absent when `gh` isn't installed; click opens the PR), listening TCP ports matched against each pane's own process tree (previously the port list was machine-global — every workspace showed the same first-20 ports), and a one-line summary of the latest terminal notification. All context flows through the existing `workspace.metadata.changed` event, so MCP clients and plugins see the same data the sidebar does.
- **UI plugin host: sandboxed sidebar panels, status-bar widgets, pane badges, and palette commands.** Drop a bundle in `~/.wmux/plugins/<name>/` with a `manifest.json` and wmux hosts its UI in a sandboxed iframe (opaque origin, no network — the postMessage bridge is the only channel out). Plugin RPCs dispatch through the same permission stack as MCP plugins (trust DB, capability enforcement, approval prompts), with new capabilities `ui.sidebar` / `ui.statusbar` / `ui.pane-decoration` / `ui.commands` / `notifications.read`. Includes a reference plugin under `examples/plugins/hello-panel`. Verified end-to-end on a live build (approval flow → mount → bridge RPC → pane badge).
- **Terminal desktop notifications (OSC 9 / OSC 777 / OSC 99) are now parsed and surfaced as events.** Programs that emit the standard notification escape sequences — iTerm2-style OSC 9, urxvt `OSC 777;notify`, and the kitty OSC 99 desktop-notification protocol (including chunked and base64 payloads) — produce a new `notification.received` event on the event bus (pollable via `wmux_events_poll`) in both daemon and local PTY modes. ConEmu's OSC 9 progress subcommands no longer trigger spurious toasts, and notification text is sanitized and length-capped. Groundwork for the attention-ring / toast-routing notification system.

### Fixed
- **`surface_list` / `pane.list` no longer report a stale, workspace-wide cwd for every surface.** Each surface's own live working directory (OSC 7 / prompt scrape) is now authoritative; the workspace-level metadata cwd — which is just whichever active surface last changed directory — is only a fallback. Previously that single path was stamped onto every surface in the workspace.
- **Panes no longer turn into X-boxes or blank out after splitting / tab-switching through many content-heavy panes in a long session.** xterm's `WebglAddon.dispose()` detaches the renderer but never frees the underlying WebGL2 context, so split/tab churn accumulated zombie contexts past Chromium's ~16-context cap, force-evicting a *live* pane's context. Every addon teardown now force-releases its GL context immediately via `WEBGL_lose_context.loseContext()`. ([#199](https://github.com/openwong2kim/wmux/pull/199), resolves [#197](https://github.com/openwong2kim/wmux/issues/197))
- **Non-selected panes no longer render garbled or blank glyphs when switching pane selection.** After long use with content-heavy panes, switching the selected pane could corrupt the *other* panes. xterm's WebGL addon shares one glyph texture atlas across every same-config terminal (`CharAtlasCache`); the focus/visible defensive repaint called `clearTextureAtlas()`, which empties that **shared** atlas and rebuilds only the newly-focused pane — the siblings kept stale per-cell texture coordinates and sampled an emptied/repositioned atlas. The repaint now does a full-range `refresh()` only and never touches the shared atlas; the earlier "garbled glyphs after a burst" case ([#166](https://github.com/openwong2kim/wmux/issues/166)) was already covered by the burst-path refresh, which never cleared the atlas. ([#196](https://github.com/openwong2kim/wmux/pull/196), resolves [#191](https://github.com/openwong2kim/wmux/issues/191))
- **MCP workspace-identity resolution no longer blocks the event loop.** The identity PID-tree walk used a synchronous `execFileSync` per ancestor; it now walks the tree with async `execFile`, preserving the resolution result and the source invariant. ([#195](https://github.com/openwong2kim/wmux/pull/195), resolves [#194](https://github.com/openwong2kim/wmux/issues/194))
- **Playwright auto-open is pinned to the calling session's workspace.** `browser.open` without an explicit workspaceId opened the browser in whichever workspace happened to be active; the engine now resolves the calling session's workspace and fails closed instead of falling back to the active one. ([#193](https://github.com/openwong2kim/wmux/pull/193), resolves [#190](https://github.com/openwong2kim/wmux/issues/190))
- **Esc now reaches the terminal under a CJK IME.** While a CJK IME composition was active (keyCode 229), xterm dropped the Esc keystroke; wmux now matches the physical key code and injects Esc directly, the same class of fix as the Ctrl+J newline issue. ([#189](https://github.com/openwong2kim/wmux/pull/189))

### Contributors
- **[@zer0ken](https://github.com/zer0ken)** — WebGL context-leak fix ([#199](https://github.com/openwong2kim/wmux/pull/199)), shared-atlas pane-corruption fix ([#196](https://github.com/openwong2kim/wmux/pull/196)), non-blocking MCP identity walk ([#195](https://github.com/openwong2kim/wmux/pull/195)), and Playwright workspace pinning ([#193](https://github.com/openwong2kim/wmux/pull/193)).
- **[@snowyukitty](https://github.com/snowyukitty)** — CJK IME Esc fix ([#189](https://github.com/openwong2kim/wmux/pull/189)).

## [3.0.0] — 2026-06-10 — external-tooling foundation, PowerShell 7 by default, terminal UX, cross-workspace hardening

Milestone release. Headline: a reference plugin and workflow-friendly APIs that make wmux a foundation external tools build on, PowerShell 7 chosen as the default shell wherever it's installed (including Store builds), a batch of terminal UX (font zoom, configurable start directory, split CWD inheritance), and the close of the cross-workspace terminal read/write isolation gap. No breaking changes — this is a milestone version bump, not a wire-format or config break; existing sessions, profiles, and configs carry over untouched. All dogfood-verified on a live build before tagging.

### Added
- **Terminal starting directory + split CWD inheritance.** New panes can inherit the active pane's working directory on split, with a global/per-profile setting for the default startup directory and a toggle for inheritance — a priority chain that leaves the main process and daemon untouched. ([#177](https://github.com/openwong2kim/wmux/pull/177), resolves [#173](https://github.com/openwong2kim/wmux/issues/173) / [#174](https://github.com/openwong2kim/wmux/issues/174) / [#175](https://github.com/openwong2kim/wmux/issues/175))
- **Keyboard zoom for terminal font size.** `Ctrl+=` / `Ctrl+-` / `Ctrl+0` grow, shrink, and reset the terminal font, resolved from the physical key code so it's IME-safe, clamped to 12–24px. ([#172](https://github.com/openwong2kim/wmux/pull/172), resolves [#171](https://github.com/openwong2kim/wmux/issues/171))
- **Rename a workspace from the right-click menu.** A Rename entry on the workspace context menu, reusing the existing inline-rename flow (same as double-click). ([#184](https://github.com/openwong2kim/wmux/pull/184))
- **Substrate reference plugin and restructured docs.** A reference MCP plugin, Diátaxis-organized documentation, a drift fix, API codegen, and a performance characterization pass — closing the external-tooling API request and giving integrators a worked example to build against. ([#165](https://github.com/openwong2kim/wmux/pull/165), closes [#15](https://github.com/openwong2kim/wmux/issues/15))

### Changed
- **PowerShell 7 is preferred over Windows PowerShell 5.1 as the default shell** wherever it's installed — including Microsoft Store builds exposed only through the WindowsApps App Execution Alias. The alias is both detected (via reparse-point resolution; `existsSync` alone misses the 85-byte symlink stub) and actually launchable (the stub can't be spawned directly by node-pty, so wmux resolves it to the real package target). Shell resolution is now single-sourced between the main process and the daemon, so the two can't drift. ([#178](https://github.com/openwong2kim/wmux/pull/178), [#180](https://github.com/openwong2kim/wmux/pull/180), [#181](https://github.com/openwong2kim/wmux/pull/181), [#186](https://github.com/openwong2kim/wmux/pull/186); resolves [#176](https://github.com/openwong2kim/wmux/issues/176), [#179](https://github.com/openwong2kim/wmux/issues/179), [#183](https://github.com/openwong2kim/wmux/issues/183), [#185](https://github.com/openwong2kim/wmux/issues/185))

### Security
- **Cross-workspace terminal read/write via spoofable workspace identity is closed.** A token-holding external MCP client could spoof `WMUX_WORKSPACE_ID` to a victim workspace and, naming that workspace's ptyId, read or write its terminal — the main-side ownership assert only verified that the ptyId belonged to the (attacker-supplied) workspaceId, not that the caller was entitled to that workspace. **Part 1** gave `input.readScreen` the `assertWorkspaceOwnsPty` check its sibling handlers already had (it was the one terminal-IO handler that skipped it). **Part 2** removed the spoofable identity the assert trusts: terminal tools (`terminal_read` / `terminal_read_events` / `terminal_send` / `terminal_send_key`) now resolve their workspace from verified PID-mapped identity only, never the env hint — a genuine external caller gets a dedicated claimed workspace, an explicit foreign ptyId fails closed, and a boot-reconcile grace keeps a first-party caller from being misclassified during a daemon respawn. ([#164](https://github.com/openwong2kim/wmux/pull/164) + [#188](https://github.com/openwong2kim/wmux/pull/188), resolves [#163](https://github.com/openwong2kim/wmux/issues/163))

### Fixed
- **Prefix-mode Toggle Zoom now actually zooms.** The tmux-style prefix Toggle Zoom toggled internal state but no rendering code read it, so the keystroke was consumed with no visible change. The zoomed pane is now rendered full-bleed (siblings hidden) and exactly restored on toggle-off, with split/close coherence and a ZOOM badge. ([#187](https://github.com/openwong2kim/wmux/pull/187), resolves [#182](https://github.com/openwong2kim/wmux/issues/182))
- **Garbled glyphs clear without a manual resize.** Panes could render corrupted glyphs until a border drag forced a repaint; wmux now repaints defensively. ([#168](https://github.com/openwong2kim/wmux/pull/168), resolves [#166](https://github.com/openwong2kim/wmux/issues/166))
- **IME input no longer wipes the typed line.** xterm's hidden IME textarea is cleared when idle, so a voice/IME input method (e.g. AutoGLM) no longer discards the already-typed line. ([#170](https://github.com/openwong2kim/wmux/pull/170), resolves [#167](https://github.com/openwong2kim/wmux/issues/167))
- **Sidebar hide/expand controls mirror correctly when docked on the right.** ([#160](https://github.com/openwong2kim/wmux/pull/160))
- **The `@electron/asar` header cache is dropped after the postPackage repack**, so the packaged asar can't be stale. ([#161](https://github.com/openwong2kim/wmux/pull/161))
- **Restored the bench B3 drop-tracking variables** lost in an earlier refactor and refreshed the perf numbers. ([#169](https://github.com/openwong2kim/wmux/pull/169))

### Contributors
Thanks to the external contributors and reporters in this release:
- **[@matdac6](https://github.com/matdac6)** — workspace Rename context-menu entry ([#184](https://github.com/openwong2kim/wmux/pull/184)), first contribution.
- **[@zer0ken](https://github.com/zer0ken)** — PowerShell 7 default-shell fixes ([#178](https://github.com/openwong2kim/wmux/pull/178), [#181](https://github.com/openwong2kim/wmux/pull/181)) and the issues behind the shell-resolution and CWD work ([#176](https://github.com/openwong2kim/wmux/issues/176), [#173](https://github.com/openwong2kim/wmux/issues/173) / [#174](https://github.com/openwong2kim/wmux/issues/174) / [#175](https://github.com/openwong2kim/wmux/issues/175), [#183](https://github.com/openwong2kim/wmux/issues/183), [#185](https://github.com/openwong2kim/wmux/issues/185)).
- **[@Dzirik](https://github.com/Dzirik)** — Toggle Zoom bug report ([#182](https://github.com/openwong2kim/wmux/issues/182)).
- **[@arcqiufeng](https://github.com/arcqiufeng)** — terminal zoom shortcut report ([#171](https://github.com/openwong2kim/wmux/issues/171)).
- **[@zhenzoo](https://github.com/zhenzoo)** — garbled-glyph ([#166](https://github.com/openwong2kim/wmux/issues/166)) and IME line-wipe ([#167](https://github.com/openwong2kim/wmux/issues/167)) reports.
- **[@alphabeen](https://github.com/alphabeen)** — external-tooling API request ([#15](https://github.com/openwong2kim/wmux/issues/15)).

## [2.18.0] — 2026-06-09 — terminal fonts, color customization, settings polish

Headline: pick any installed terminal font (and ship the recommended ones so they work everywhere), a point-and-style color inspect mode for theming, and a settings UI polish pass. All dogfood-verified on a live build before tagging.

### Added
- **Pick any installed terminal font.** The font setting is now a combobox over every font installed on the machine — click to browse the full list (each option rendered in its own face), type to filter, with a live Latin+Hangul preview so you can confirm a mixed-mono font has fixed-width CJK glyphs before committing. A separate "custom" entry mode takes any family name by hand for not-yet-installed fonts. Fixes a silent `powershell.exe` ENOENT (a bare-name spawn that failed to resolve under Electron) which had made the installed-font enumeration return nothing — so the feature never actually worked before this. ([#155](https://github.com/openwong2kim/wmux/pull/155), resolves [#147](https://github.com/openwong2kim/wmux/issues/147))
- **Bundled terminal fonts.** JetBrains Mono, Fira Code, and JetBrainsMonoHangul now ship with the app (alongside the existing Cascadia Code/Mono), so the recommended fonts — including fixed-width Hangul — work on every machine without a manual install. All under the SIL Open Font License 1.1; license texts are bundled and listed in THIRD_PARTY_NOTICES. ([#158](https://github.com/openwong2kim/wmux/pull/158))
- **Point-and-style color inspect mode.** Click a chrome region to recolor it by theme token, with contrast-safety checks so a custom palette stays readable. ([#156](https://github.com/openwong2kim/wmux/pull/156))

### Changed
- **Settings tabs use SVG line icons** in place of the dated unicode glyphs. ([#148](https://github.com/openwong2kim/wmux/pull/148))
- **Settings design-system pass** — shared primitives, accessibility fixes, and tab-label i18n. ([#150](https://github.com/openwong2kim/wmux/pull/150))
- **i18n:** Claude integration and first-run setup tab bodies are now translated across 21 locales ([#152](https://github.com/openwong2kim/wmux/pull/152)); the color customization strings across 22 locales ([#157](https://github.com/openwong2kim/wmux/pull/157)).

### Fixed
- **Ctrl+J inserts a newline even with a CJK IME active.** Inside in-pane TUIs (codex, Claude Code) Ctrl+J intermittently failed to add a newline — it worked with the IME off and broke with a Chinese / Japanese / Korean IME on. The byte pipeline below xterm is transparent to `\n`; the keystroke was lost at xterm's keyboard layer, which derives Ctrl+&lt;letter&gt; from the deprecated `KeyboardEvent.keyCode`. With the IME enabled the keydown reports `keyCode === 229` ("Process") with `key !== 'j'`, so xterm's `65–90` branch never matched and emitted nothing. wmux now resolves the newline keys (Shift+Enter, Ctrl+J) from the physical `event.code` and writes the byte itself — the same IME-safe approach already used for the split shortcuts — so Ctrl+J sends `\n` regardless of IME state. It defers while an IME composition is active (so a preedit is never split) and when the user has bound Ctrl+J to a custom keybinding. xterm 6 has no kitty/modifyOtherKeys path, so the emitted byte matches its legacy output when no IME is active. ([#153](https://github.com/openwong2kim/wmux/pull/153))
- **`--squirrel-firstrun` no longer becomes a never-quitting zombie.** On Windows the Squirrel first-run hook was misclassified, so the process neither initialized nor quit, leaving an idle GPU/network process behind after install. ([#154](https://github.com/openwong2kim/wmux/pull/154))

### Contributors
Thanks to the external contributors in this release:
- **[@zer0ken](https://github.com/zer0ken)** — SVG settings-tab icons ([#148](https://github.com/openwong2kim/wmux/pull/148)) and the font picker proposal ([#147](https://github.com/openwong2kim/wmux/issues/147)).
- **[@snowyukitty](https://github.com/snowyukitty)** — Ctrl+J newline fix under CJK IME ([#153](https://github.com/openwong2kim/wmux/pull/153)).

Bundled fonts under the SIL Open Font License 1.1: JetBrains Mono (The JetBrains Mono Project Authors), Fira Code (The Fira Code Project Authors), and JetBrainsMonoHangul (Janghyub Seo).

## [2.17.1] — 2026-06-08 — MCP pane-lifecycle fixes

Two small MCP fixes on top of v2.17.0, both dogfood-verified on a live build before tagging.

### Fixed
- **`browser_close` no longer leaves an empty pane behind.** The UI close path removes a pane when its last surface is closed, but the MCP mirror only closed the surface — leaving an empty leaf that the "auto-create initial surface" effect backfilled with a fresh terminal. A `browser_open`/`browser_close` loop accreted blank PowerShell panes. The handler now snapshots whether the closed surface was the pane's last one *before* removing it, then cascades into `closePane` to mirror the UI path. A browser sharing a split pane with a terminal still only loses the surface; a browser that is a workspace's only (root) pane still gets an auto-terminal, matching the UI exactly. ([#144](https://github.com/openwong2kim/wmux/pull/144))
- **Stale pid-map anchors are pruned on workspace/pane close.** The pid→ptyId anchor that backs MCP workspace-identity resolution was only pruned on `session:died`, so closing a workspace or pane through the UI (the `destroySession` path) leaked its anchor. Over time those stale entries could mis-resolve a ghost workspace identity. Closing now prunes the anchor immediately, in lockstep with the session teardown. ([#142](https://github.com/openwong2kim/wmux/pull/142))

## [2.17.0] — 2026-06-07 — security hardening sweep, packaged browser fixes, workspace UX

The big batch since v2.16.2. Headline: a security-hardening sweep across the daemon, MCP, A2A, release pipeline, and browser surfaces — most of it surfaced by an external codex security scan, with each finding triaged and adversarially verified before merge (a chunk turned out to be false-positives or duplicates and were closed rather than merged). Plus a set of fixes that make the embedded browser tools work on packaged builds, per-workspace environment/startup profiles, and the workspace-management UX that profiles implied (duplicate, per-terminal working directories). No config changes required — defaults are unchanged.

### Added
- **Per-workspace process profiles.** Each workspace can define environment variables and an optional startup command, applied to **new panes only** — existing and recovered daemon PTYs keep their create-time environment. Right-click a workspace → "Configure profile…". Generic by design (no provider hardcoding): point `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, SSH wrappers, etc. at different accounts per workspace. This is environment separation, not an OS-level security sandbox. See [docs/workspace-profiles.md](docs/workspace-profiles.md) for setup and multi-account recipes. ([#101](https://github.com/openwong2kim/wmux/pull/101), [#103](https://github.com/openwong2kim/wmux/pull/103))
- **Workspace management actions.** Right-click a workspace to **duplicate** it — the layout (fresh pane/surface ids, cleared ptyIds so new panes spawn their own PTYs) and the profile (re-normalized through the secret-name policy) are cloned as `<name> (copy N)`. A new **Working directories** menu lists each terminal's live cwd with copy; every terminal now **tracks its own cwd** (shown in the tab tooltip), terminal tabs can be **renamed** (double-click), and an accidental workspace close is **guarded by a confirmation**. New-pane semantics throughout, consistent with the profile contract. ([#141](https://github.com/openwong2kim/wmux/pull/141))

### Security
- **Token-file ACL grants by the labeled SID.** `getCurrentUserSid` parsed the first SID-shaped substring of `whoami` output, so a SID-shaped account or machine name (e.g. `S-1-1-0` = Everyone) could be granted the auth-token ACL instead of the real owner, leaving the token world-readable. It now parses the explicit `SID:` field. ([#118](https://github.com/openwong2kim/wmux/pull/118))
- **Token-file DACL is rebuilt owner-only, even on the upgrade path.** The shipped `icacls /grant:r … /inheritance:r` only replaced the named principal's ACE and stripped *inherited* ACEs, so a pre-existing **explicit** broad ACE (e.g. `Everyone:(R)` from a redirected/roamed/MDM profile) survived and left the token world-readable. The DACL is now rebuilt with a .NET DACL-only primitive (no owner/group/SACL writes, so it needs no privilege and succeeds on the upgrade-from-icacls state), with icacls as a fail-closed fallback when PowerShell is blocked. ([#140](https://github.com/openwong2kim/wmux/pull/140))
- **MCP approvals bind to the reviewed capability snapshot.** A plugin could redeclare broader capabilities while an approval prompt was pending and get trusted for a set the user never saw (a TOCTOU between consent and call). The approval now pins the exact capabilities shown in the dialog. ([#122](https://github.com/openwong2kim/wmux/pull/122))
- **Terminal drops are restricted to wmux drag sources.** Text dragged from a browser or another app no longer routes straight into a terminal PTY (where embedded newlines could auto-run at a shell prompt); only internal wmux drags — sidebar, surface tabs, file tree — write to the pane. ([#123](https://github.com/openwong2kim/wmux/pull/123))
- **Default MCP terminal resolution fails closed.** A spoofable `WMUX_WORKSPACE_ID` env hint or a failed workspace claim could fall back to the user's active pane, i.e. cross-workspace keystroke injection/read. Terminal tools now require a verified, PID-mapped identity and refuse the env hint, throwing rather than touching the focused pane. ([#125](https://github.com/openwong2kim/wmux/pull/125))
- **A2A sender identity is authoritative.** Company A2A `send`/`broadcast` no longer accept a caller-supplied `from`; the sender is derived from the authenticated workspace, so one agent can't impersonate another (or the CEO) when delivering a message into a peer's terminal. ([#129](https://github.com/openwong2kim/wmux/pull/129))
- **Inter-agent PTY delivery is bracketed-paste wrapped.** A2A messages written into a peer's terminal are bracketed and ESC-sanitized so an embedded newline can't submit a command in the receiving shell. ([#132](https://github.com/openwong2kim/wmux/pull/132))
- **Remote SOUL prompt loading is disabled.** Company agent personas were fetched from a third-party URL at spawn and written verbatim into the agent's instruction file — a remote prompt-injection / supply-chain path into command-capable agents. Spawning now uses the built-in role prompts only. ([#131](https://github.com/openwong2kim/wmux/pull/131))
- **RPC browser profile switching is scoped.** An RPC caller could mount an arbitrary Electron persistent partition or the human's pre-seeded `login` session store (reading its cookies over CDP). Profile names are now validated and RPC selection is restricted to a safe allowlist. ([#133](https://github.com/openwong2kim/wmux/pull/133))
- **IPv6 navigation SSRF hardening.** The navigation URL validator now un-brackets and bit-masks IPv6 literals (unique-local, link-local, IPv4-mapped), closing a bracket bypass that reached internal addresses through the `browser_tabs` new-tab path. ([#137](https://github.com/openwong2kim/wmux/pull/137))
- **Bundled first-party MCP server runs under enforce mode.** Under packaged enforce mode the bundled server was denied because it never went through declare/approve, so wmux's own tools were locked out. A name-recognized, scoped allowlist lets the first-party tools run without opening the gate to third-party servers. ([#109](https://github.com/openwong2kim/wmux/pull/109))
- **Release pipeline hardening.** The release tag is passed through `env:` instead of being interpolated into a shell `run:` block (Actions script-injection); the SignPath token is scoped to the signing step instead of the whole job; third-party release actions are pinned to immutable commit SHAs; WinGet publishing moved to a least-privilege job; and the installer fails closed when the checksum manifest is missing or invalid. ([#119](https://github.com/openwong2kim/wmux/pull/119), [#120](https://github.com/openwong2kim/wmux/pull/120), [#121](https://github.com/openwong2kim/wmux/pull/121), [#126](https://github.com/openwong2kim/wmux/pull/126), [#135](https://github.com/openwong2kim/wmux/pull/135))
- **Recursive IPC error-log redaction.** The structured IPC error logger now redacts sensitive keys at any depth, redacts startup-command values, and summarizes env maps to a key count — so workspace-profile env/commands flowing through `pty:create` can never leak into `args_summary`. Profile env is also kept out of the copy-session-info / drag-export markdown, and reserved `WMUX_*` keys are rejected so a profile can't spoof workspace identity. ([#103](https://github.com/openwong2kim/wmux/pull/103))
- **Child shells never inherit a stale wmux identity.** A wmux launched from inside a wmux pane (e.g. `npm start` while dogfooding) inherited the parent pane's `WMUX_WORKSPACE_ID` / `WMUX_SURFACE_ID` / `WMUX_SOCKET_PATH` in its own environment, which could survive into freshly created child shells. The whole reserved `WMUX_*` namespace is now cleared from the spawn baseline before identity is forced, so a child's identity is only ever what wmux explicitly sets — the spoofing guarantee is now unconditional, not profile-only. ([#141](https://github.com/openwong2kim/wmux/pull/141))

### Fixed
- **Embedded browser tools work on packaged builds.** On packaged builds `getPage()` can't surface the `<webview>` guest as a Playwright `Page`, so a swath of browser tools failed with `No browser page available`. They now fall back to the main-process CDP/RPC channel: DOM tools read the real webview instead of the wmux app shell ([#104](https://github.com/openwong2kim/wmux/pull/104)), extraction/snapshot ([#105](https://github.com/openwong2kim/wmux/pull/105)), console/network/response-body capture ([#106](https://github.com/openwong2kim/wmux/pull/106)), `browser_extract_data` field mapping ([#110](https://github.com/openwong2kim/wmux/issues/110)), cookies/storage/emulate/resize ([#111](https://github.com/openwong2kim/wmux/issues/111)), geolocation grants + reset semantics ([#112](https://github.com/openwong2kim/wmux/pull/112)), and `browser_wait` ([#114](https://github.com/openwong2kim/wmux/pull/114)). `browser_open`/`session_start` route through `requireWorkspaceId` so the browser opens in the calling workspace, not the active one ([#96](https://github.com/openwong2kim/wmux/pull/96)).
- **Memory-leak audit survivors.** Three real leaks found in a leak audit are now bounded: the MCP capture buffer (a Page-keyed WeakMap), the A2A GC hard cap, and PTY listener cleanup. ([#102](https://github.com/openwong2kim/wmux/pull/102))
- **Per-terminal working directory is reported correctly (local and daemon mode).** The tab tooltip and the workspace "Working directories" menu showed each shell's startup home directory (e.g. `C:\Users\me`) for every PowerShell regardless of where it had `cd`'d. Two compounding parser bugs are fixed: OSC 7 left Windows paths as `/C:/Users/me` (leading slash, forward slashes), and prompt detection matched the stale echoed prompt and froze the reported cwd at startup. Parsing is extracted into a unit-tested `cwdDetect` module (shared by both spawn paths) that normalizes the OSC 7 URI to a native path — including UNC shares — and reads the live (last) prompt. Daemon mode additionally never forwarded its detected cwd to the renderer; a new `session:cwd` event now closes that gap so daemon-backed panes live-update like local ones. ([#141](https://github.com/openwong2kim/wmux/pull/141))
- **Tighter workspace right-click menu.** The context menu was pinned to a fixed minimum width, leaving a wide blank gutter beside short items (and an oversized gap before the "Working directories" submenu arrow); it now sizes to its content. ([#141](https://github.com/openwong2kim/wmux/pull/141))

### Contributors

This release leaned on the community — two external contributors landed real features and fixes, not just reports.

**[@junbeom09](https://github.com/junbeom09) (조준범)** carried forward the packaged-build hardening he started in 2.16.2. Dogfooding the packaged app, he found the browser DOM tools were silently reading the wmux app shell instead of the embedded `<webview>` — a bug that never reproduces in a dev build — and contributed the runtime shell-detection fix (#104). He then verified the CDP capture and geolocation fallbacks (#108/#112) on a real install, confirming the exact paths CI can't prove. Fixes and reports from real-world setups a single maintainer never sees are how wmux gets more robust.

**[@snowyukitty](https://github.com/snowyukitty)** had the busiest release of anyone. He built per-workspace process profiles end to end (#101), then followed up after review with path-pointer credential-var allowlisting and non-destructive profile loading so an existing profile is never clobbered on load (#103). He shipped the workspace-management UX that profiles implied — duplicate workspace, the working-directories menu, per-terminal cwd tracking, tab rename, and close confirmation — and fixed the OSC 7 / prompt-detection cwd bugs and the child-shell identity-inheritance leak along the way (#141). He also split the Vitest runtime lane (#97) so timing-sensitive tests run serially instead of flaking under parallel load.

The security-hardening sweep (#118–#137) was surfaced by an external codex security scan; each of the 20-plus findings was triaged and adversarially verified before landing, with false-positives and duplicates closed rather than merged. The token-file ACL rebuild (#118 plus the DACL-only primitive in #140) was additionally dogfooded against a real `%USERPROFILE%\.wmux` descriptor — a directory that grants SYSTEM and Administrators inherited FullControl — to confirm the hardened token comes out owner-only with no self-lockout.

Maintained by [@openwong2kim](https://github.com/openwong2kim), with engineering and code-review pairing by Claude (Anthropic). Thanks to everyone filing issues and dogfooding. 🙏

## [2.16.2] — 2026-06-03 — daemon hardening: security, split-brain fix, configurable lifecycle

Bundles everything merged since v2.16.1: a token-file permission hardening (security), the duplicate-daemon / split-brain fix behind the "relaunch resets my terminals" bug, configurable daemon lifecycle thresholds, and idle-reap diagnostics. No config changes are required — defaults are unchanged.

### Security
- **Token-file ACL is applied by owner SID, not username.** The daemon auth-token file's ACL was tightened by passing the account name to `icacls`, which mojibakes under the OEM codepage for non-ASCII (e.g. Korean) usernames and could lock the owner out of their own token. The ACL is now keyed by the owner's SID, with an ASCII-only fallback guard. (#90)

### Fixed
- **No more duplicate daemon / split-brain on relaunch.** "Quit (keep sessions) → relaunch" could spawn a second daemon that fell back to a `-N`-suffixed pipe, leaving the first daemon's session pipe in `EADDRINUSE` and the UI unable to reattach — terminals appeared to reset. A three-defect chain is closed: `isProcessAlive` swallowing its probe error into `false`, the canonical-pipe reclaim conflating a live owner with a zombie, and the `-N` fallback itself. A confirmed live owner on the canonical pipe now makes the redundant daemon exit cleanly so the launcher reconnects to the existing one. (#93)
- **`maxSessions` counts only live sessions.** Dead tombstones no longer occupy slots against the cap, so a low `maxSessions` won't be exhausted by sessions that have already exited. (#92)
- **Recovered sessions keep their saved dead-TTL.** A recovered session preserves the dead-session TTL it was created with instead of silently inheriting the current default. (#92)

### Added
- **Configurable lifecycle thresholds.** Five daemon limits became config keys with the former hardcoded values as defaults: `maxSessions` (200), the memory `warn`/`reap`/`block` triple (500/750/1024 MB), and `suspendedTtlHours` (7d). Out-of-range or malformed values are clamped per-field — not whole-file reset — with a startup warning, so a single bad value can't brick the daemon. `maxRecoverSessions` is derived from `maxSessions` rather than configured separately. Documented in PROTOCOL.md §7–§8. (#92)
- **Idle-shutdown diagnostics.** When the daemon is held alive past its grace window, the watchdog now logs which signal is keeping it up (active connections vs. live sessions) or that it is counting down to self-terminate, so a daemon that fails to reap an empty session set can be diagnosed from its log instead of a live-process inspection. (#95)

### Contributors

Special thanks to **[@junbeom09](https://github.com/junbeom09) (조준범)** for the token-file ACL hardening (#90). He hit the non-ASCII-username lockout firsthand: a Korean account name turned the `icacls` principal into mojibake under the Windows OEM codepage and locked the owner out of their own auth token. He traced the root cause and contributed the SID-based fix that makes the hardening codepage-proof for every user. Reports like this, from real-world setups a single maintainer never sees, are exactly how wmux gets more robust. 🙏

Maintained by [@openwong2kim](https://github.com/openwong2kim), with engineering and code-review pairing by Claude (Anthropic). Thanks as always to everyone filing issues and dogfooding the daemon-lifecycle work.

## [2.16.1] — 2026-06-01 — daemon false-death fix, resize console-spam fix

A stability patch. The headline: on slow or loaded machines the daemon's process monitor could mistake a probe timeout for a dead process and reap a session that was actually alive, so sessions appeared to close on their own. That's fixed. It also quiets an `Uncaught (in promise)` console flood on relaunch and adds session-death logging so future "why did my session close" reports are diagnosable.

### Fixed
- **Live sessions are no longer killed on a probe timeout.** ProcessMonitor treated a slow or timed-out `tasklist` probe as proof the process had died and reaped the still-alive session — the cause behind sessions closing by themselves under CPU contention or a Defender scan. It now reaps only on positive confirmation of death; a probe that fails or times out defers instead of killing.
- **No more `Uncaught (in promise)` flood on relaunch.** A burst of terminal resizes during reconnect could exceed the daemon's per-socket rate limit, and the renderer never caught the rejection, spamming the console. Resize calls now swallow the transient rejection and re-send the live geometry once after the rate window clears, so a resize dropped during the burst self-heals instead of leaving the terminal stuck at the wrong size.

### Added
- **PTY session-death logging.** When a session dies the daemon now logs its exit code, signal, and idle time, so an unexpected session close can be diagnosed from the log instead of guessed at.

## [2.16.0] — 2026-05-30 — tmux-style persistence, blank-relaunch fix, multiline-paste fix, stability batch

Bundles everything merged since v2.15.0 (#81, #84). The headline is tmux-style persistence — closing the window now keeps your daemon and sessions alive and reattaches them on next launch — plus the fix for recovered sessions rendering blank on relaunch, a multiline-paste fix for PowerShell, and a batch of dogfood-driven stability and UX changes.

### Added
- **Quit keeps your sessions running.** The tray now offers "Quit (keep sessions running)" — it detaches the UI while the daemon and all PTYs survive, and the next launch reattaches them — plus a separate "Shut down wmux (close all sessions)" for a full teardown. This is the tmux model the README always described.
- **`Ctrl+Shift+Arrow` moves focus** between panes (and between grid tiles in multiview) in all four directions. Bare `Ctrl+Arrow` is intentionally unbound.
- **Completion blink.** A pane whose agent just finished (or is waiting / awaiting input) blinks its border, and its background tab shows a status dot, so you can see which terminal needs you without hunting. Clears on focus; respects `prefers-reduced-motion`.

### Changed
- **Quit now detaches instead of killing the daemon.** `before-quit` previously tried to shut the daemon down on every quit (the opposite of tmux), and a hung handler could orphan it. The default quit now only detaches; full shutdown is explicit and guaranteed to exit.
- **RAM readout is real RSS** (`app.getAppMetrics` working-set sum) instead of the renderer's JS heap, so the StatusBar number reflects actual process memory.
- **Removed the token-usage chip.** The regex-scraped per-pane token estimate was unreliable and is gone, along with its IPC and tracker. The measured 5h / 7d usage-percentage widget stays.
- **Right-click copy keeps the selection** and no longer collides with the paste gesture (a fast second right-click used to paste over a just-copied selection).
- **Multiline paste into PowerShell** inserts a clean multiline command instead of injecting whitespace at every line break (see Fixed).

### Fixed
- **Recovered sessions no longer render blank on relaunch (#81).** Daemon reattach ran inside the terminal-creation effect behind an `isCurrent` guard evaluated before the effect assigned the terminal ref, so `pty.reconnect` never fired (live daemon sessions, zero attach). Reattach moved to a dedicated effect that runs after the ref is set and also fires on `daemon:connected` (late-connect / respawn).
- **Orphan daemon on quit.** A hung `before-quit` pipe-close could leave `wmux.exe` running after the window closed; full shutdown now force-exits within a bounded timer.
- **Multiline paste injected whitespace in PowerShell (#84).** `normalizePasteText` collapsed every newline to a lone CR, but inside a bracketed-paste body PSReadLine treats CR as Enter and misplaces the cursor (PSReadLine #3939, #417, which both recommend LF). It now emits LF as the in-body separator when bracketed (CR otherwise), fixing all four paste paths (Ctrl+V, Ctrl+Shift+V, right-click, Shift+Insert / `onData`). Verified against real pwsh 7.6 / PSReadLine 2.4.5.
- **`prefix` + arrow keys.** Session load now merges the saved prefix config over the defaults instead of replacing it wholesale, so arrow-key pane-focus bindings survive a reload.
- **WebGL context thrash.** An LRU pool (max 12) caps live WebGL terminal contexts, preventing the "too many contexts" eviction that could blank panes when 16+ are visible at once.

### Security
- **Paste-injection guard (#84).** The bracketed-paste body sanitizes a raw ESC to `U+241B`, so pasted text can no longer forge the `ESC[201~` close marker and run trailing bytes as a command.

### Docs
- Dropped the removed `Ctrl+Up/Down` scroll-bookmark jump shortcut from the README. `Ctrl+M` marking and the gutter indicators still work.

## [2.15.0] — 2026-05-29 — Hook-RPC flood fix, view-switch perf, install/updater hardening

Fixes the user-reported "freezing under load" and view-switch lag found via a dogfood-log RCA, finishes the remaining session-reliability hardening from the v2.14.0 RCA, makes the installer and auto-updater integrity-safe, and wires (inert) OSS code signing.

### Fixed — hook-RPC timeout floods / UI freezes (Issue A1, A2)
- `hooks.signal` no longer does a renderer `workspace.list` round-trip on every signal. A 2s-TTL coalescing cache collapses a tool-heavy turn's bursts into ~1 round-trip and serves the last-known list when the renderer is throttled — stopping the `PostToolUse` timeout floods that froze the UI and, at worst, blocked the daemon event loop into a forced respawn.
- The Claude Code bridge retries *transient* connect-errors within its 2s budget (and never re-fires a request it already wrote), so a brief main-process restart window no longer drops hooks.

### Fixed — session reliability (RCA A1/A9, A4, A6)
- Partial-list reconcile now re-queries the daemon before clearing a live `ptyId` absent from a non-empty session list (2-strike guard), closing the last destructive-session-loss path the v2.14.0 RCA left open.
- The daemon health probe tolerates a busy-but-responsive daemon — `daemon.ping` reports event-loop lag, thresholds raised to 5 strikes / 5s — instead of mistaking load for a hang and force-respawning.
- `DaemonClient.connect` retries transient named-pipe errors (EPERM/ECONNRESET) with backoff; ENOENT still fails fast.
- Session-pipe bind retries on `EADDRINUSE`, so a pane no longer dies when a prior pipe has not yet released its name.

### Fixed — view-switch / multiview performance
- WebGL terminal contexts are no longer disposed the instant a pane is hidden. A short grace period (cancelled on re-show) eliminates the GPU-context create/destroy thrash behind workspace-switch and multiview→single-view lag.

### Added — auto-update integrity (fail-closed)
- The updater downloads the `Setup.exe` and verifies a CI-published SHA-256 (`update-manifest.json`) before launching it; a tampered or unverifiable artifact is never run. Previously it opened an unverified URL.

### Added — hook-RPC flood observability
- A rolling 30s summary of slow/failed `workspace.list` resolutions is logged (escalating to a warning on a flood), so degradation is visible without hand-tallying `bridge.log`.

### Changed — install funnel
- `install.ps1` now downloads the prebuilt, SHA-256-verified `Setup.exe` by default instead of always compiling from source. Build-from-source is opt-in (`-FromSource` / `WMUX_FROM_SOURCE=1`).

### Changed — docs & security accuracy
- Corrected the README "RunAsNode disabled" claim and reconciled `SECURITY.md` / `PROTOCOL.md` with the actual code (token entropy, `icacls` behavior, intentionally-disabled asar-integrity fuse). Removed the permanently-disabled EditorPanel "Save" affordance.

### Added — code-signing pipeline (inert until configured)
- `release.yml` is wired for SignPath Foundation (OSS) Authenticode signing of the installer, gated on a signing secret so it is a no-op until configured. Binaries remain unsigned (SmartScreen "unknown publisher") until the certificate is provisioned.

## [2.14.0] — 2026-05-29 — Session-replacement fix + lifecycle observability + token ACL hardening

Fixes the reported instability where, while running several Claude Code windows, "the daemon resets and sessions get replaced by new empty windows." Root-caused via a multi-expert review (see `plans/RCA-daemon-session-replacement-2026-05-29.md`): the daemon process never actually dies (uptime is monotonic). The renderer's reconnect/reconcile path could not distinguish a *transient* failure from a *permanent* one and destructively cleared live `ptyId`s, making Terminal self-create empty sessions while the daemon still held the originals.

### Fixed — live sessions replaced on reconnect (RCA A1/A2)
- `pty.reconnect` now tags failures `transient` (pipe-not-writable / RPC threw during handler swap) vs permanent (session dead). `useTerminal` retries transient failures with short backoff instead of immediately clearing the surface — a live session no longer gets discarded on a momentary blip.
- `AppLayout` reconcile preserves all `ptyId`s when the daemon returns an empty session list (almost always "not ready yet", not "all dead"). The late-reconnect (`daemon:connected`) path is now abort/timeout/catch guarded and never falls through to `clearAllPtyState`.
- `RECONCILE_TIMEOUT_MS` is now derived from `DAEMON_RPC_TIMEOUT_MS` in `shared/timeouts.ts` (15s > 10s), removing the asymmetry that let a slow-but-successful `pty.list` trip the destructive startup fallback.

### Added — daemon/main lifecycle observability (RCA A8)
- Structured `[lifecycle]` logging on daemon `attachSession`/`detachSession`, main `daemon:connected` emit, `DaemonClient.connect` error codes (EPERM etc.), `pty.list` live-session count, and the renderer's destructive `ptyId`-clear decisions (mirrored into the main log). Reconnect/session-replacement events are now diagnosable post-hoc instead of invisible.

### Security — token file ACL re-hardening (RCA A12)
- `secureWriteTokenFile` only locked permissions when a token was freshly written; a token loaded from disk kept whatever (possibly broad, inherited) ACL it had. New `reHardenTokenFileAcl()` re-applies a restrictive ACL (Windows `icacls`) / `chmod 0600` (POSIX) on the existing `daemon-auth-token` and `~/.wmux-auth-token` at load time. Best-effort: never crashes a live daemon.

### Fixed — session config merge + prefix mode
- Merge session config against defaults on load and harden prefix mode handling.
- Skip keybinding back-fill on key collision.

## [2.13.0] — 2026-05-29 — OSC 133 EventBus tee + agent.awaiting_input lifecycle

Extends the `agent.lifecycle` event in `wmux_events_poll` with two new substrate signals so orchestrator SDKs and any MCP consumer can react to shell command lifecycle and agent approval prompts without polling `terminal_read_events`. Both signals are wired BOTH on the local-mode PTYBridge path AND on the daemon-mode DaemonNotificationRouter path (the default production path).

Minor version bump (v2.12.0 → v2.13.0) because the `AgentLifecycleEvent` payload gains a new `source: 'osc133'` enum value, a new `kind: 'agent.awaiting_input'` enum value, a nullable `agent` field (only null when `source === 'osc133'`), and an optional `exitCode` field. The `AgentStatus` union also gains `'awaiting_input'`. All additive — existing v2.12.x consumers that switch on the previous enum values keep working unchanged.

### Two new lifecycle signals (#76)

- **`source: 'osc133'`** — every OSC 133 D shell-integration marker (e.g. from PowerShell, bash with VS Code shell integration, Ghostty, any CLI wrapped with prompt instrumentation) now tees onto the EventBus as `kind: 'agent.stop'` with the parsed `exitCode`. Latency-zero, shell-agnostic: orchestrators waiting on `npm install` / `pytest` / `make` / any CLI no longer need a heuristic detector. `agent` is set to the AgentDetector last-known slug when one is gated, otherwise `null`. OSC 133 events bypass the `HookSignalRouter` dedup ledger (always `decision: 'emit'`) — they represent shell command lifecycle, not agent-turn boundaries.

- **`kind: 'agent.awaiting_input'`** — `AgentDetector` now emits a distinct lifecycle kind when an agent surfaces a y/N or approval prompt mid-turn (Claude Code patterns `Do you want to proceed?` and `Allow tool use for <Tool>`). Distinct from `agent.stop`: orchestrators that auto-approve trusted operations can react to this kind to feed pre-approved answers without waiting for the turn to end. Routed through the same dedup ledger used for `agent.stop`.

### Added

- **`AgentLifecycleEvent.source` enum** — `'hook' | 'detector' | 'osc133'`.
- **`AgentLifecycleEvent.kind` enum** — `'agent.stop' | 'agent.subagent_stop' | 'agent.awaiting_input'`.
- **`AgentLifecycleEvent.exitCode?: number | null`** — present on `source: 'osc133'` events; absent on hook / detector sources.
- **`AgentStatus = … | 'awaiting_input'`** — sidebar renders the new state as a yellow dot with the `workspace.agentAwaitingInput` label (en + ko translated; 21 other locales fall through `Partial<TranslationMap>` to en).
- **`AgentSignalKind = … | 'agent.awaiting_input'`** — detector-only kind today; hook bridges are not expected to emit it but the union now admits it so dedup ledger entries share one shape.
- **`scripts/osc133-awaiting-input-dynamic.mjs`** — end-to-end verification that spawns the packaged Electron app, exercises the **daemon-mode** path (the default production path), and asserts the new EventBus tee signals show up via `wmux_events_poll`. Result on this branch: 15/15 checks pass with a `daemon-`-prefixed `ptyId`, confirming the daemon-path emit reaches the main process EventBus.

### Fixed

- **Daemon-mode OSC 133 + awaiting_input mirror** — the first cut wired the tee only on `PTYBridge` (the local-mode path). Daemon-backed PTYs — the default production path — parsed OSC 133 markers in `DaemonPTYBridge` and appended them to `PromptEventLog` but never forwarded them up to the main process, so consumers saw `source: 'osc133'` events in tests but never in real-world sessions. `DaemonNotificationRouter` now subscribes to a new `session:prompt` daemon broadcast and emits the EventBus tee from the production path. The `awaiting_input` lifecycle had the same gap; both are fixed together. Caught by Codex round-1 P1 review and verified end-to-end against the packaged build.
- **OSC 133 agent-attribution race** — `emitOsc133Lifecycle` now snapshots the cached agent slug **before** awaiting `workspace.list`. The shell can emit `OSC 133;D` and then redraw the prompt in the same burst (firing a new `session:agent` event); without the pre-await snapshot, the OSC 133 emit would carry the **next** turn's agent slug. Matches the PTYBridge local-mode case 133 path, which reads `agentDetector.getLastAgent()` synchronously before any emit. Caught by Codex round-2 P2.
- **Approval-prompt regex tightened to whole-line anchors** — `Do you want to proceed?` and `Allow tool use for <Tool>` are now anchored at both ends of the line, with only whitespace and Claude TUI box-drawing glyphs (`│ ║ ┃ ═ ━ ─ ┄ ┅ ┆ ┇ ┈ ┉ ╭ ╮ ╯ ╰ ╔ ╗ ╝ ╚ ┌ ┐ ┘ └ ·`) admitted as padding. Conversational mentions in agent output such as `Answer Do you want to proceed? with caution` or `Please click Allow tool use for Bash` no longer emit `agent.awaiting_input` — false positives are costly here because orchestrators may auto-feed approval responses. Codex rounds 1 → 5 progressively tightened this from an unanchored phrase match to a full-line anchor with canonical MCP tool-name grammar `mcp__<server>__<tool>` (two `__` separators required, hyphens permitted, single-underscore identifiers rejected).

### Changed

- `WmuxEventType` is **unchanged**; `agent.lifecycle` was already present in v2.12.x. Only the payload shape grows.
- `wmux_events_poll` MCP tool description updated to enumerate the three sources, new kind, and `exitCode` field so MCP-aware orchestrators discover the surface from introspection alone.
- `DaemonEvent.type` gains a `'prompt.event'` variant — the daemon-side broadcast carrying parsed OSC 133 PromptEvents to the main process.

### Test

- New `DaemonNotificationRouter.lifecycle.test.ts` (10 cases) covering detector `awaiting_input` emit, regression on `waiting` / `complete`, OSC 133 exitCode parsing, missing-suffix path, non-D ignore, agent slug cache, `HookSignalRouter` bypass for OSC 133, and `session:died` cache invalidation. Plus a race-fix test that mocks a deferred `workspace.list` and verifies the OSC 133 emit carries the **pre-await** snapshot, not the post-burst cache value.
- New cases in `PTYBridge.lifecycle.test.ts` covering local-mode OSC 133 (exit code 0 / 1, no-suffix, A/B/C ignore, workspaceId gate, gated agent slug, dedup bypass), local-mode `awaiting_input` detection, regex false-positive immunity for mid-line `Do you want to proceed?` and `Allow tool use for`, regex true-positive on boxed prompts including corner glyphs (`╮`, `─`), canonical MCP tool name matching (`mcp__github__create_issue`, `mcp__context7__get-library-docs`), and rejection of non-canonical single-underscore names.
- Full suite: 2003/2004 (the one failure is `StateWriter.test.ts:102` — the known cross-OS runner-load timeout flake first observed during v2.12.0 ship, independent of this PR; passes cleanly on rerun).
- 5 rounds of Codex independent review: round 1 caught the two daemon-path P1 architectural gaps, rounds 2 – 5 progressively tightened detector regex correctness. All rounds passed the merge gate.

## [2.12.0] — 2026-05-28 — MCP plugin permission enforcement + daemon lifecycle hardening

Lands the active enforcement layer for the Phase 2.1 MCP plugin substrate (PR #71) alongside a wave of lifecycle, identity, and UX hardening (PR #72/#74/#75). Plugins now have their declared capabilities verified on every RPC; the daemon self-shuts when idle and recovers from AV-blocked PID verification; a frozen `WMUX_WORKSPACE_ID` env can no longer leave in-pane MCP servers permanently stuck on a stale identity; xterm light themes are now WCAG-AA legible for true-color RGB white output; and keyboard pane/surface navigation finally moves DOM focus along with the visual marker.

Minor version bump (v2.11.0 → v2.12.0) because Phase 2.2 adds the `RpcRejection` discriminated union to `RpcResponse`'s failure arm, the `daemon.idleShutdownMinutes` config, and the `mcp.mode` config flag. All additive; existing v2.11.x callers keep working.

### Daemon lifecycle hardening (#72)

Closes four gaps in the wmux daemon lifecycle: an orphan daemon that survives forever in RAM after a forced wmux quit, a boot-block when anti-virus prevents PID verification, an opaque "daemon could not start" error after the respawn budget exhausts, and a transient first-ping race during cold-boot. Combined effect: the "1 wmux ≙ 1 daemon" invariant is now self-healing instead of relying on the next clean shutdown.

### Added

- **Daemon idle self-shutdown** — the daemon now terminates itself after 5 minutes with zero RPC clients and zero live PTY sessions (configurable via `daemon.idleShutdownMinutes` in `~/.wmux/config.json`; set to `0` to keep the legacy "alive forever" behavior). Routes through the same `shutdown()` body used by SIGTERM / SIGINT / `daemon.shutdown` RPC, so the existing phase instrumentation and re-entry guard apply. Logs `[shutdown.phase] idle.timeout idleMs=… cfgMs=…`.
- **`DaemonPipeServer.getConnectionCount()` / `getLastDisconnectAt()`** — public accessors for the Watchdog idle predicate. The disconnect anchor is stamped only on the 0-edge (last socket closing), so a flapping reconnect cycle resets the idle deadline forward instead of accumulating stale idle time.
- **`Watchdog` idle-check hook** — opt-in callbacks `onIdleCheck` / `onIdleShutdown` evaluated on every health tick. Decision logic exposed as `evaluateIdle()` so unit tests drive it without timers. Single state machine: `idleMs = now − (lastDisconnectAt ?? startTime)`. Grace window and idle window are independently configurable.
- **`scripts/daemon-idle-shutdown-dynamic.mjs`** — end-to-end verification that spawns the bundled daemon in an isolated tmp `WMUX_DIR` with `WMUX_IDLE_SHUTDOWN_MS` / `WMUX_IDLE_GRACE_MS` / `WMUX_WATCHDOG_TICK_MS` env overrides, connects, disconnects, and asserts the daemon exits cleanly with the `idle.timeout` breadcrumb. Runs in ~5s.

### Fixed

- **Launcher ping retry** — `ensureDaemon` now retries the first `daemon.ping` once with a 250ms delay before declaring the existing daemon unresponsive. Absorbs the cold-boot race where Defender realtime scan, ConPTY cold-init, or a large recovery loop makes the daemon miss the first 3-second ping window. Total worst case 6.25s, still well under the 15s spawn budget.
- **Unverified-live PID is now recoverable** — when anti-virus blocks `tasklist.exe` / `Get-CimInstance` and the launcher cannot confirm what owns `daemon.pid`, it now prompts the user with an Electron dialog offering "Clean up and start fresh" instead of refusing to boot. Cancel re-throws the legacy error, now annotated with the exact elevated-PowerShell `taskkill /F /PID …` command for manual recovery.
- **Respawn-exhausted is no longer silent** — `DaemonRespawnController` now captures the latest error message from the bootstrap or respawn loop and ships it on the `respawn-exhausted` event. `main` surfaces it via a native `dialog.showErrorBox` plus the existing renderer IPC channel, with concrete recovery steps. `lastError` is cleared on successful install so future exhaustions don't echo stale diagnostics.
- **SIGKILL-failure throw now embeds the recovery command** — when the OS refuses to terminate a verified-stale daemon (typically EPERM under AV / different-user scenarios), the thrown error now includes the exact `taskkill /F /PID …` invocation the user needs in an elevated PowerShell. No silent `taskkill` fallback because `process.kill('SIGKILL')` already walks the same `TerminateProcess` path with the same user token; embedding the hint is more honest than retrying.

### Changed

- `DaemonRespawnController.RespawnEvent` — the `respawn-exhausted` variant now carries an optional `lastError` field. Additive change; existing consumers that ignore the field still type-check.
- Suppression env var `WMUX_NO_DIALOG=1` bypasses both the launcher recovery dialog and the respawn-exhausted dialog for automated runs.

### Test

- New `idleShutdown.test.ts` (source-level invariants for the daemon main wiring), new idle-flow test cases in `Watchdog.test.ts`, new `getConnectionCount` / `getLastDisconnectAt` lifecycle test in `DaemonPipeServer.test.ts`, new `lastError` propagation test in `DaemonRespawnController.test.ts`, and `scripts/daemon-idle-shutdown-dynamic.mjs` for the end-to-end path.

### Workspace identity drift fix (#72)

Fixes a serious multi-agent bug: an in-pane MCP server (e.g. Claude Code) could get permanently stuck reporting a workspace id that no longer exists — `a2a.whoami` returning `no workspace found for ws-…` and `terminal_send` rejecting with `not owned by workspace … (actual owner: …)`. Every identity-gated MCP call (A2A, `terminal_*`, browser routing) failed until the MCP server was restarted. Triggered when a workspace id is re-minted (daemon respawn / session restore) while the shell process — and its frozen `WMUX_WORKSPACE_ID` env — lives on.

### Fixed

- **Workspace-identity is now anchored to the immutable `ptyId`, not a frozen workspace id.** The on-disk PID map (`~/.wmux/pid-map/<pid>`) stores the ptyId; `a2a.resolve.identity` resolves the **current** owning workspace live from the renderer (`input.findOwnerWorkspace`) on every call. A re-minted workspace id can no longer produce a stale identity. The map is also re-anchored on `pty.reconnect`, so a surviving shell re-adopted after a respawn resolves correctly without a restart.
- **MCP resolvers (`src/mcp`, `src/company/mcp`) no longer permanently trust the env hint.** `WMUX_WORKSPACE_ID` is demoted to a last-resort fallback behind the live PID-walk; an RPC that reports a stale identity (`no workspace found` / `not owned by workspace`) invalidates the in-process cache so the next call self-heals.

### Changed

- `a2a.resolve.identity` returns PID → **current** workspaceId (resolved live), legacy `ws-`-prefixed pid-map entries pass through for one cycle, and ptyIds with no live owner are omitted (no phantom mappings).
- `docs/PROTOCOL.md §6.1` reordered: path B (live PID-walk) is now preferred over path A (stale-prone env hint); added the `ptyId`-anchor and self-heal notes.

### Phase 2.2 MCP plugin permission enforcement (#71)

Lands the active enforcement layer on top of the Phase 2.1 record-only identity + grammar substrate (PR #48) and the spec-side default rules (PR #68). Plugins that declare a capability set via `mcp.declarePermissions` now have those declarations verified against every RPC they issue; mismatches return a structured `RpcRejection` describing the per-path failure, and unconfirmed declarations surface a user-approval prompt before the call can proceed.

### Added

- **`PermissionEnforcer` substrate (`src/main/mcp/PermissionEnforcer.ts`)** — pure-function permission gate. Given a method, params, request context, and trust record, returns `allow`, `reject`, or `partial`. Same function runs in both shadow and enforce modes; only the dispatcher's reaction changes.
- **Single declarative `methodCapabilityMap`** — `Record<RpcMethod, RequiredCapability>` covering the full 96-method RPC surface. `tsc --noEmit` enforces totality so a new method without a gate entry fails the build. Identity bootstrap (`mcp.identify`, `mcp.declarePermissions`, `system.identify`, `system.capabilities`) is `capability: null`. Internal surfaces (daemon, company, surface, hooks) map to the reserved `wmux.internal` capability that no plugin can declare.
- **Structured `RpcRejection` discriminated union** on `RpcResponse`'s failure arm — `capability-not-declared`, `path-not-allowed`, `paths-partially-allowed` (with `{allowed, rejected[]}`), and `identity-status` (with optional `pendingApproval.promptId`). Additive on the existing `{ok:false; error}` arm; every `switch (r.ok)` site keeps narrowing.
- **`ShadowRejectionLogger` + JSONL audit log at `~/.wmux/shadow-rejections.log`** — discriminated entries (`rejection` / `legacy-traffic`). 1 MiB cap with single-generation rotation. Sync writes wrapped in try/catch — telemetry must never affect RPC throughput.
- **`LegacyTrafficCounter`** — per-method milestones (1st / 10th / 100th / 1000th / 10000th call) for envelope-less RPCs, flushed to the shadow log. Replaces the previous process-once trust-DB write for accurate v3.1 surfacing data.
- **`ApprovalQueue`** — `(clientName, hash(declaredCapabilities))` dedupe key, synchronous promptId minting + async resolution. On approve/deny, writes through `PluginTrustStore.setUserDecision`. Multiple inflight RPCs from the same plugin during a prompt coalesce onto one modal.
- **`PermissionApprovalDialog`** — risk-class-grouped capability list with asymmetric wording. Terminal-content (`terminal.read`, `pane.search`) and terminal-input (`terminal.send`) get critical-severity copy that names the concrete privilege ("can read what's on your screen, including secrets"); metadata / events / pane-lifecycle / workspace get neutral copy. Browser and A2A get caution.
- **`mcp.mode` config flag** in `~/.wmux/config.json` — `shadow` or `enforce`. Production wmux defaults to `enforce`; dev (`electron-forge start` / `NODE_ENV=test`) defaults to `shadow` for dogfood rollback safety.
- **`PluginTrustStore.setUserDecision(name, 'trusted' | 'denied')`** — explicit user-decision write path. Seeds a fresh record when a prompt fires before `mcp.identify` lands.
- **Spec §4.4 "Enforcement contract"** — documents the wire shape, retry idiom, mode flag, and worked glob example (`meta.write:custom.foo` ≠ `custom.foo.bar` without trailing `*` or `**`).
- **`inventory.md` Phase 2.2 capability map** — per-method capability + path-source + risk-class column.

### Changed

- `RpcRouter.dispatch` now calls the enforcer before invoking the handler. In `shadow` mode, the would-be rejection is logged and the handler still runs (no behavior change for v2.x callers). In `enforce` mode, a non-allow outcome returns the RpcResponse failure WITHOUT calling the handler. `legacy` callers (no `clientName` envelope) and identity-bootstrap RPCs are always allowed.
- `ApprovalQueue.requestApproval` returns `{ promptId, resolution }` — the promptId is available synchronously so the dispatcher can thread it into the rejection without awaiting the user's decision.

### Fixed

- **Keyboard pane/surface navigation now moves keyboard focus, not just the active border** (`src/renderer/hooks/useActivePaneFocus.ts`). Switching panes with the tmux prefix arrows, `Alt+Ctrl+Arrow`, `Ctrl+Tab`, the RPC `pane.focus` bridge, or keyboard tab-switching moved the red active border (driven by `ws.activePaneId`) but left DOM focus on the previously focused pane's xterm — so keystrokes still landed in the old pane. xterm routes input from whichever textarea holds DOM focus, and no navigation path ever called `terminal.focus()`. A central `useActivePaneFocus` hook now pulls DOM focus onto the resolved active terminal whenever the target workspace/pane/surface changes, covering every state-only switch path in one place. Mouse clicks were unaffected (the click focuses the target xterm for free) and remain so.

### Notes for plugin authors

- Plugins SHOULD retry on `rejection.pendingApproval.promptId` with 1–5 s backoff. The substrate doesn't pin a socket waiting for the user (50-connection cap; OAuth `authorization_pending` precedent).
- `meta.write:custom.foo` matches the EXACT path `custom.foo`. Declare `meta.write:custom.foo.*` or `meta.write:custom.foo.**` to cover the subtree.
- `events.poll` is `partial`-mode multi-path: subscribing to mixed-allowed topics returns the allowed subset with a `paths-partially-allowed` rejection on the failure arm carrying both `allowed` and `rejected` lists. `pane.setMetadata` and `pane.clearMetadata` are `all-or-nothing`.

### Light xterm theme contrast (#74)

Claude Code (and several other TUI apps) emit foreground text as true-color RGB white (`#FFFFFF`). Those escape sequences bypass our `sandstone-light` / `paper-light` xterm palettes, so the literal white rendered directly on hinomaru's cream background (`#FAF8F5`) and read as invisible — users could not see Claude Code's output at all on hinomaru/taegeuk.

### Fixed

- **xterm `minimumContrastRatio` set to `4.5` (WCAG AA) on light themes.** Detected via `isLight(background)` on the resolved palette; covers built-in light themes and any custom palette a user configures to a light tone. Dark themes keep the default ratio of `1` so intentionally subtle dimmed foregrounds (e.g. catppuccin-mocha's `text-muted`) remain unmodified.
- Applied at both the initial `new Terminal({...})` site **and** the runtime theme-switch effect, so toggling between themes inside a live session takes effect without remounting the terminal.

### Keyboard pane navigation DOM focus (#75)

Switching panes with the keyboard moved the red active border but typing still landed in the previously focused pane. xterm routes keystrokes from whichever `<textarea>` currently holds DOM focus; navigation paths (`focusPaneDirection`, `cyclePane`, surface-tab switches, RPC `pane.focus`) only updated state, never called `terminal.focus()`. Mouse clicks were unaffected because the click focuses the target xterm DOM for free — so only keyboard paths were broken.

### Fixed

- **`useActivePaneFocus` central hook (`src/renderer/hooks/useActivePaneFocus.ts`)** — subscribes to the resolved active terminal (workspace + pane + surface) and pulls DOM focus onto that xterm whenever the target changes, closing every state-only switch path in one place rather than patching four call sites. Retries across a few animation frames so a freshly split pane's xterm still gets focus once `useTerminal` registers it. Declines non-terminal surfaces (browser/editor).

### Test

- New `src/renderer/hooks/__tests__/useActivePaneFocus.test.ts` — 11 cases on the pure resolution logic (`resolveActivePanePtyId`), including pane-switch and same-pane tab-switch coverage that directly pins this bug, plus browser/editor/empty-ptyId rejection. The DOM-focus application half (`terminal.focus()` + rAF retry) needs a browser harness the node-env vitest lacks and is verified by dogfood.

## [2.11.0] — 2026-05-26 — Orchestrator substrate + Claude Code hook plugin

Lands the substrate piece that the new [`@wmux/orchestrator`](https://github.com/openwong2kim/wmux-orchestrator) npm SDK consumes, plus the Claude Code hook plugin integration that delivers sub-200ms agent-completion signals (vs the heuristic regex detector). Minor version bump because the new `agent.lifecycle` event type is additive — no breaking changes vs v2.10.x clients.

### Added

- **`agent.lifecycle` EventBus tee from hook + detector sources (#63).** New `WmuxEventType` `agent.lifecycle` streams whenever a supported inner agent (Claude Code today; others via the `integrations/<slug>` bridge later) finishes a turn or subagent span. Tee sites:
  - `hooks.rpc.ts` — Claude Code Stop / SubagentStop hooks fire RPCs that emit the event with `source: 'hook'`. Sub-200ms, deterministic. Both `emit` and `dedup` decisions stream so observers can compare.
  - `PTYBridge.ts` AgentDetector — regex-based fallback for any agent, emits with `source: 'detector'` (~1-2s lag).
  - `DaemonNotificationRouter.emitDetectorLifecycle` — daemon-backed PTYs (the default production path) — sync `recordDetector` call before async workspace.list resolution so dedup timing matches local-mode.
  Carries `ptyId`, `kind` (`agent.stop` | `agent.subagent_stop`), `source`, `agent` slug, `decision` (`emit` | `dedup`). Polled via the existing `wmux_events_poll` MCP tool with the type filter extended.

- **Claude Code hook plugin Phase 1 integration backbone (#60).** Adds the `integrations/claude-code/hook-plugin/` directory that bridges Claude Code's hook events into wmux's signal pipeline. Foundation for the structured agent observability surface.

- **Phase 1.5 signal-health + Phase 2 usage-meter + env-first routing (#61).** Per-pane signal-health plumbing (~140 LOC across substrate only — proxy metric layers like cumulative / percent / banner were dropped after the Codex review). 5-hour and 7-day usage windows. Env-first hook routing fix so `WMUX_HOOK_TARGET` overrides config-derived destinations.

### Fixed

- **NOTICE files preserved for Apache 2.0 §4(d) compliance (#62).** Bundled third-party NOTICE files now survive the electron-forge pack step, satisfying the Apache 2.0 attribution clause for the dependencies that ship one.

### Documentation

- README: SmartScreen install guidance for the unsigned installer (#66).
- README: pointer to the new `@wmux/orchestrator` SDK in the MCP integration section (#67).

### Compatibility

- No breaking changes vs v2.10.x. Existing MCP clients keep working.
- New `agent.lifecycle` event type is additive — clients that don't filter for it won't see it.
- `@wmux/orchestrator` v0.1.x requires wmux ≥ 2.11.0 (the version this `agent.lifecycle` tee actually ships in — the SDK README mention of "≥ 2.10" was off by one).

## [2.10.2] — 2026-05-22 — First-launch input race fix + helper-orphan cleanup

Two prod-only bugs surfaced during fresh-PC dogfood of v2.10.1. Neither
reproduced under dev (`npm start`) because the vite dev-server load delay
hides the underlying daemon-bootstrap timing.

### Fixed

- **First-launch keystroke loss on fresh installs.** v2.10.1's
  `DaemonRespawnController` introduced a race between renderer mount and
  the LOCAL→DAEMON IPC handler swap. On cold-start PCs the daemon spawn
  stretches into hundreds of ms (Defender realtime scan + ASAR cold cache
  + ConPTY cold start), wide enough for the renderer to mount and reach
  handler-swap mid-startup. Any `pty.write` that carried a LOCAL-prefix
  id (`pty-N`) into the DAEMON handler was silently dropped because
  `sessionPipes.get('pty-N')` is undefined — manifesting as "the first
  keystroke does not register" or "only the first keystroke registers"
  on the very first session. Fix splits renderer navigation out of
  `createWindow()` into a standalone `loadMainRenderer()` export and
  defers the call until after `bootstrap()` returns and
  `markDaemonReady()` has unblocked `daemon.whenReady()`. Every
  `pty.create` from the renderer now hits a stable handler topology and
  produces a correctly-prefixed id. The macOS `app.on('activate')`
  re-open path keeps the immediate-load default because the daemon is
  already healthy by then.

- **Helper-orphan zombies on quit.** `before-quit` has five awaits
  (renderer save, sleep, daemon shutdown race up to 8s, disconnect,
  cleanup) before `app.quit()`. Any hang (stuck `pipeServer.stop()`,
  detached webview blocking `will-quit`, ConPTY/OSC 7 finalization
  stall) leaves Electron's renderer / GPU / utility helpers as orphans.
  On Windows the dev `npm start` Ctrl+C path also leaks helpers because
  SIGINT only reaches `npm.exe`, not the electron tree. Reproduced
  locally as 20-helper orphan buildup spanning days. Add a 1.5s
  `setTimeout` after `app.quit()` that calls `app.exit(0)` if the
  graceful path has not finalized; `unref()` keeps the timer
  non-blocking so a normal sub-second quit isn't held open. The
  graceful path is unchanged — this only fires on hang.

### Internal

- `.team/` added to `.gitignore` so worktree coordination metadata
  cannot leak into future commits — matches the existing `.claude/` /
  `.gstack/` exclusions (Codex `/codex review` P2 finding).

## [2.10.1] — 2026-05-22 — Notification system expansion + CI hardening

Five-surface notification system (StatusBar bell, pane border ring, Windows
taskbar flash, in-app toast, sidebar dot) with per-workspace mute, four new
user settings, and a pure-function policy refactor of the notification
dispatcher. Two CI hardening fixes also land.

### Added

- **NotificationBell on StatusBar.** The existing `● {unreadCount}` element is
  now a clickable accessible button (native `<button>`, dynamic `aria-label`,
  focus-visible outline, 24x24 minimum click area, 999+ clipping). Click opens
  the notification panel.
- **Pane NotificationRing.** Per-pane state machine: flash 500ms → glow steady
  → cleared on focus or read. Honors `prefers-reduced-motion` (instant
  transitions) and `forced-colors: active` (Windows high-contrast 2px border).
- **Auto-markRead on pane focus.** Clicking a pane marks its notifications read
  and clears the ring entry — but only if at least one notification was
  actually marked, so plain focus clicks don't wipe a fresh flash.
- **Relative time format in NotificationPanel.** Replaces `hh:mm` with
  `just now` / `Xm ago` / `Xh ago` / `Xd ago` / local date. Future-skew safe.
- **Taskbar flashFrame on Windows.** Window unfocused + new notification
  arrives → taskbar flashes for attention. Auto-clears on window focus.
  `BrowserWindow.isDestroyed()` guard prevents Electron throw.
- **Per-workspace mute.** Each workspace can be muted from SettingsPanel.
  Muted workspaces still record notifications in the panel; bell badge
  excludes them; toast/sound/ring/flashFrame are suppressed.
- **Four new settings toggles.** Pane ring on/off, pane flash on/off,
  taskbar flash on/off, notification sound choice (default/none).
- **`markAllRead()` global + `jumpToUnread()` selector.** Global mark-all
  button in NotificationPanel (separate from the existing per-workspace one).
  `jumpToUnread` navigates to the most recent unread workspace without
  marking read.
- **NotificationPanel a11y.** `role="dialog"`, initial focus on first unread,
  Esc closes, Tab cycles, screen-reader announces "{type}, {title},
  {timeAgo}, {read|unread}" per row.

### Fixed

- **Notification ring lifecycle.** Ring entries are now cleared on every
  user-action read path (`Pane.handleClick`, `markAllRead`,
  `setActiveWorkspace`, `removeWorkspace`) so panes can no longer get stuck
  in 'glow' after the user already handled the notification.
- **Listener refactor.** `useNotificationListener` is now a thin IPC
  dispatcher that delegates decisions to `useNotificationPolicy` (pure
  function, testable in isolation). Replaces the module-scope mutable
  `lastSoundTime` map with `createThrottler(ms)` closures (per-NotificationType
  for sound, global 500ms for flashFrame burst protection).
- **`runSnapshotOnce` test 7-day time bomb.** The test used a hardcoded
  `lastActivity: '2026-05-15T00:00:00Z'` for a suspended session, which
  `SUSPENDED_TTL_HOURS = 168` pruned exactly 7 days later. Test now uses a
  dynamic `Date.now() - 1h` so the fixture never expires.
- **`ProcessMonitor` CI flake.** `watch()` left the first probe to the first
  `setInterval` tick; under CI CPU contention two `tasklist` execs could
  exceed the test's 5s timeout. `watch()` now triggers an immediate first
  probe (production benefit: dead-PID detection is no longer up-to-5s
  delayed). Test timeout bumped to 20s with documented latency reasoning.

### Internal

- 12 IRON-RULE regression tests lock down previously untested but correct
  behavior in the notification stack (cap eviction, throttle, target
  resolution, active-surface skip, toggle plumbing).
- Test suite total: 1665 tests, 136 files. Five consecutive stable
  full-suite runs verified post-fix.

## [2.10.0] — 2026-05-18 — tmux prefix expansion + 16 new locales

This release rounds out the tmux-style prefix layer with pass-through and three new
bindings, fixes a long-standing dead-event handler on the workspace rename shortcut,
and ships UI translations for 16 additional locales.

### Added

- **tmux pass-through.** Pressing the prefix combo twice (`Ctrl+B Ctrl+B` by default)
  now forwards a literal Ctrl+B byte to the active terminal, so a nested tmux/screen
  session running inside a wmux pane receives its own prefix instead of being
  swallowed by wmux.
- **Three new prefix bindings.** `,` opens inline rename for the active workspace,
  `&` closes the workspace (disposing every PTY in its tree first), `?` redisplays
  the keyboard cheat sheet even after it has been permanently dismissed.
- **16 new UI locales:** Arabic, Bosnian, Danish, German, Spanish, French, Hindi,
  Indonesian, Italian, Malay, Norwegian Bokmål, Polish, Brazilian Portuguese, Russian,
  Thai, Turkish, Ukrainian, Vietnamese, and Traditional Chinese. Switch from
  **Settings → Appearance → Language**.

### Fixed

- **Workspace rename actually works now.** Both the new `Ctrl+B ,` prefix action and
  the existing `Ctrl+Shift+R` shortcut previously dispatched a custom event that no
  component was listening for, so neither path opened the inline rename input. The
  sidebar's `WorkspaceItem` now subscribes to the event on the active workspace.
- **`?` prefix re-opens the cheat sheet after permanent dismissal.** The `AppLayout`
  mount gate previously prevented the cheat sheet from rendering at all once the user
  clicked "Don't show again", so the one-shot force-show flag had nothing to react to.
  The gate now honors the override.
- **`?` prefix works after a previous cheat sheet auto-expired.** The 30-second
  countdown now clears the force-show flag when it hits zero, so the next `?` press
  flips the selector and re-triggers the show effect.

### Changed

- **`createPrefixActions` factory.** The prefix-mode action registry in
  `useKeyboard.ts` is now an exported factory taking `{store, electronAPI, doc}`, so
  unit tests can drive every action with mocks instead of needing a DOM harness.
  32 new unit tests cover every action plus the `ctrlByteForKeyCode` pass-through
  helper.

## [2.9.1] — 2026-05-17 — Scrollback restore hotfix

v2.8.x 이후 silently broken 이었던 scrollback restore 를 살리는 hotfix release. tray Quit → restart 시 모든 pane 이 fresh empty terminal 로 뜨던 증상의 진짜 root cause 3개를 모두 잡았다 (다층 race). 사용자 dogfood 로 end-to-end 검증 완료.

업그레이드 영향:

- 모든 변경은 v2.9.x backwards-compatible. 새 wire contract / disk schema 없음.
- 새 설정 한 개: **Settings → Terminal → "시작 시 복원"** (Restore on launch, default ON). 끄면 매 launch fresh 시작.
- 누적된 session.json ↔ daemon dump mismatch 가 있어 복원 안 보이는 사용자를 위해 `scripts/scrollback-reset.mjs` 한방 cleanup util 제공 (백업 후 정리, 비파괴).
- 로그 파일이 자동으로 14일 retention 으로 정리됨 (이전엔 무제한 누적, 일부 사용자에서 ~700MB 까지 부풀었던 사례).

### Added

- **Scrollback restore 토글** (`uiSlice.scrollbackRestoreEnabled`, default `true`) — Settings → Terminal 에서 끌 수 있음. OFF 시 startup 에 `clearAllPtyState()` 로 모든 pane fresh 시작. daemon 은 ringBuffer dump 계속 (renderer 가 안 읽어서 orphan `.buf` 는 다음 launch `cleanOrphanedBuffers` 가 청소). en/ko/ja/zh i18n.
- **Log auto-prune** (`main/util/logSink.ts`, `daemon/util/logSink.ts`) — 14일 이상 된 daily log 파일 startup 시 자동 삭제. 이전엔 retention 정책 없어 무제한 누적.
- **`scripts/scrollback-reset.mjs`** — 비파괴 cleanup util. `~/.wmux/buffers/`, `sessions.json*`, `%APPDATA%/wmux/session.json*` 를 `~/.wmux/backup-<timestamp>/` 로 이동 (삭제 아님). 사용자가 session.json ↔ daemon dump mismatch 누적된 상태를 한 번에 청소할 수 있음.
- **`scripts/scrollback-restore-test.mjs`** — bundled daemon subprocess + RPC probe 기반 dynamic test. recovery + flush bytes contract regression 가드.

### Fixed

- **L1 — `workspaceSlice.loadSession` ptyId wipe 제거**. 매 startup 마다 모든 `surface.ptyId` 를 `""` 로 force-clear 하던 코드가 reconcile 의 reconnect 경로 진입 자체를 막고 있었다. saved ptyId 는 이제 보존된다. 대신 `AppLayout` 이 `paneGate` (`'pending' | 'ready'`) render gate 로 PaneContainer mount 를 reconcile 완료 이후로 미뤄서 옛 propagation race 를 원천 봉쇄한다. 추가로 `clearAllPtyState` cross-slice atomic clear action 이 reconcile 실패/timeout 시 explicit fallback.
- **L2 — `BEFORE_QUIT_TIMEOUT_MS` 4s → 8s** (cherry-picked from `fix/daemon-shutdown-phase-instrumentation` #45). 50-pane daemon 에서 4초로는 buffer dump 가 못 끝나 다음 launch 가 recovery 할 게 없던 상태. 동시에 daemon-side `logSink` (`daemon/util/logSink.ts`) + `[shutdown.phase]` per-phase 지표 + `[recovery] session X bytes=N` 가시화 도구 도입 — 이게 없었으면 다음 layer 진단 자체가 불가능했다.
- **L3 — `pty.reconnect` race-free 재구성**. `AppLayout.reconcilePtys` 는 이제 sync liveness check 만 (dead ptyId clear, live 는 그대로). 실제 reconnect 호출은 `useTerminal` mount 안에서 모든 listener 등록 *후* 발생. 이전 구조는 daemon SessionPipe replay (10KB+) 가 `win.webContents.send(PTY_DATA, …)` 로 forward 됐을 때 renderer `ipcRenderer.on(PTY_DATA)` listener 가 아직 없어 Electron IPC 가 silently drop 하던 게 진짜 사용자 가시 root cause 였다.
- **`pty.reconnect` failure 처리** — `{success: false}` 응답을 더 이상 swallow 하지 않는다 (`useTerminal` 가 `clearSurfacePtyIdByPty` 호출 → Terminal self-create fallback). 이전엔 dead session 이 stale ptyId 로 input-mute 영구 유지될 수 있었음 — 정확히 Fix 0 이 없애려던 클래스.
- **`daemonMode` flag race** — `isDaemonModeActive` 를 startup IIFE 안에서 paneGate 가 ready 로 바뀌기 *전* 에 명시 set. 이전엔 별도 effect 가 set 해서 Terminal 이 `daemonModeAtMount=false` 로 mount 되고 reconnect 자체를 안 부르던 케이스 가능.
- **Startup IIFE outer try/finally** — `session.load()` rejection 이 `.then` 안의 try 를 우회해서 `paneGate` 가 영구 pending 으로 갇히던 edge 봉쇄.
- **`useRpcBridge` startup-window 가드** — external RPC (MCP, A2A) 가 startup 중에 stale `ptyId` 로 write 들어오는 걸 `{error: 'wmux is still starting', retryable: true}` 로 차단.
- **`main/util/logSink.ts` stdout tee** — 이전엔 `stderr` 만 tee 해서 `console.log` 결과가 disk 에 안 남았다 (`console.warn`/`error` 만 capture). renderer 진단 라인이 main log file 에 같이 누적되도록 console-message `level<2 return` 필터도 제거.

### Out of scope (다음 PR 후보)

- **Fix B** (cap-aware suspended-session promote) — 50-pane 이상에서 `MAX_RECOVER_SESSIONS=40` 초과 session 은 여전히 복원 못 함. design doc `docs/internal/scrollback-restore-design.md` §5 에 spec. TODOS.md 에 항목 등록. 50-pane thundering herd (codex P1#3) 와 함께 처리.
- **Substrate Phase 2+ Fix C** — 2-storage 통합. weeks 단위 작업. 별도 트랙.
- **`AppLayout.gate` integration test** — vitest config 가 현재 `environment: 'node'` 라 jsdom + RTL setup 필요. follow-up.

### 외부 협의 / Reviews

- **Codex outside-voice** — plan 단계에서 13 holes 지적 → plan v2 resolution map 에 모두 매핑. 최종 pre-merge review 에서 추가 P1 3 + P2 3 — P1 + red test 는 fix, P1#3 (thundering herd) 와 P2#6 (session-end timeout) 은 known limitation 으로 명시 + 다음 PR 로 deferred.

PR: **#46** (path-D inventory, docs), **#45** (daemon instrumentation + before-quit timeout 8s), **#47** (Fix 0 — three-layer race fix + toggle + log prune).

## [2.9.0] — 2026-05-14 — Substrate 3.0 — Phase 0 + M0

wmux의 substrate identity 를 v3.0 으로 끌고 가기 위한 첫 번째 ship unit. v2.8.x 에서 이미 ~50% 가 출하돼 있던 substrate 표면 (PaneMetadata, EventBus, bootId, asOfSeq, `system.capabilities`, MCP host, `mcp.claimWorkspace`) 위에 (a) 그 표면의 contract 를 명문화한 Phase 0 문서, (b) main process 측 metadata authority 인 `MetadataStore` 와 그 wire 통합 (M0-a~f), (c) v2.8.x dogfood 중 노출된 스크롤백 손상 + reconcile race + logSink durable write 안정성 픽스를 한꺼번에 ship. **메인 PR 은 #34** (Substrate 3.0 — Phase 0 + M0, v2.9.0 ship unit) 이고 후속 마이그레이션 도구는 **#35** (chopped-dump recovery tool) 로 따라간다. 외부 RFC 협의는 **#15 (@alphabeen)** 에서 진행됐고 그 OCC + `mergeMode` 디자인이 코드로 착지.

업그레이드 영향:

- 와이어 contract 는 v2.x 와 backwards-compatible 이다 (`expectedVersion`, `mergeMode`, `pane.metadata.changed` 의 `version` 모두 additive optional).
- 디스크에 새로 등장하는 폴더: `userData/wmux/scrollback/corrupted/` 와 `scrollback/*.txt.bak[.1..3]` 회전 슬롯. 둘 다 자동 관리.
- v2.8.x 사용자가 첫 부팅 때 일부 패널 스크롤백이 비어 보일 수 있다 — 이미 디스크에 chopped 형태로 저장돼 있던 dump 가 v2.9.0 detector 에 의해 격리되기 때문. 데이터는 격리 폴더에 보존되며 `scripts/recover-scrollback.mjs` 로 사람이 읽을 수 있는 텍스트로 복원 가능. 자세한 가이드는 `docs/upgrade-v2.9.0.md` 참조.

### Added

- **Substrate 3.0 contract documentation** — `docs/PROTOCOL.md` (substrate wire contract: layered status, namespacing, optimistic concurrency, `mergeMode`, cursor opaqueness, snapshot reconciliation, permission enforcement sketch, Named Pipe token security model), `docs/api/{inventory,versioning,stability}.md` (모든 RPC/MCP/event 의 stability tier + semver + 자동 업데이트 호환 정책), `docs/internal/{m0-design,paneSlice-callsite-inventory}.md` (M0 race specs + paneSlice 변경 blast-radius).
- **`MetadataStore` 모듈 (M0-a)** — main process 의 `PaneMetadata` authority. `get` / `set` / `clear` / `snapshot` / `hydrate` / `serialize` / `migrate` / `onPaneDeleted`, per-pane monotonic `version`, `expectedVersion` 기반 OCC, 세 가지 `mergeMode` (`merge` / `replace` / `replaceShared`). 31 unit test 가 CRUD + version + mergeMode 트랜잭션 + OCC + 검증 + snapshot + persistence + EventBus emission 을 cover, codex full-stack review 가 catch 한 3건 (`replaceShared` 의 custom 보호, 누적 size cap, `updatedAt` 추가 후 cap 적용) regression test 포함.
- **`pane.resolveActiveLeaf` IPC 채널 (M0-b)** — caller 가 `paneId` 를 생략하면 main 이 renderer 에 active leaf id 를 query (read-only, paneSlice 쓰기 0) 한 뒤 MetadataStore 에 commit. codex P1 review 가 잡은 split-store read-after-write 구멍 닫힘.
- **`MetadataStore.snapshot()` ↔ `pane.list` 통합 (M0-c)** — `pane.list` envelope 가 store snapshot 으로 anchored, `asOfSeq` 가 snapshot lineage 를 반영. renderer 가 더 이상 metadata 를 자체 합성하지 않음.
- **`SessionManager.saveMetadataSync` 와이어 (M0-e)** — MetadataStore 의 persist callback 이 `metadata.json` 에 atomic write, launch 시 store 가 그 파일에서 hydrate. codex P2 review 가 잡은 strict field validation 포함.
- **Wire format 추가 (M0-f)** — `pane.setMetadata` 가 optional `expectedVersion` + `mergeMode`, reply / event / list 가 optional `version` 필드. v2.x subscriber 영향 없음 (모두 additive).
- **Optional `version` 필드** on `pane.metadata.changed` events.
- **PR template** with CHANGELOG + stability-tier sections.
- **`atomicWriteText` / `atomicReadText`** (sync + async) — `core.ts` 의 JSON 변종과 짝이 되는 텍스트 변종. rotation chain + quarantine 파이프라인 공유. JSON 변종이 parseable payload 를 전제하기 때문에 raw-bytes contract 가 필요한 스크롤백을 위해 sibling 으로 분리.
- **Cols-collapse corruption detector** (`src/main/scrollback/corruption.ts`) — chopped dump 의 on-disk 시그니처 (median 비공백 행 길이 ≤ 3자, CRLF 바이트 비율 ≥ 0.3) 휴리스틱 검출기. 단일 패스 스캔, allocation 최소. 15 unit test 가 production v2.8.4 fixture (median=1, max=60 까지 outlier 살아남은 chopped 파일) 와 false-positive 저항 (정상 출력, sparse 세션, narrow pane, ANSI-rich 로그, 단일 긴 줄) cover.
- **`scrollbackDump` util 모듈** (`src/renderer/utils/scrollbackDump.ts`) — renderer 의 dump serializer 를 `AppLayout.tsx` 에서 분리. eligibility 가드 (cols < 12 / rows ≤ 0 / `terminal.element.offsetWidth === 0` / detached) 가 unit-testable. 13 test 가 각 가드 branch + happy path 를 pin.
- **`scripts/recover-scrollback.mjs` (#35)** — read-only 마이그레이션 CLI. v2.8.x → v2.9.0 첫 부팅에서 `corrupted/` 로 격리된 chopped dump 를 reverse-reflow 로 사람이 읽을 수 있는 텍스트로 복원. `node:util` `parseArgs` 기반, dry-run / verbose / 입출력 dir 오버라이드 지원. 19 unit test (detector parity + 순수 transform + processFile e2e + CLI plumbing). 출력은 별도 폴더로만 쓰고 격리 원본은 절대 수정하지 않음.
- **`docs/upgrade-v2.9.0.md` (#35)** — v2.8.x → v2.9.0 사용자 마이그레이션 가이드. `corrupted/` 폴더의 의미, 첫 부팅 시 무엇을 보게 되는지, 복원 스크립트 사용법, 복원 한계, 롤백 절차, FAQ.

### Changed

- **README** opening 이 LSP-for-terminals substrate 프레이밍 으로 시작 (AI agent 가치 제안과 tmux 대체 키워드는 보존).
- **`pane.{set,get,clear}Metadata` 핸들러 (M0-b)** 가 `MetadataStore` 로 라우팅. paneSlice 는 더 이상 RPC metadata path 에 의해 mutate 되지 않음.
- **paneSlice 가 mirror-only (M0-d)** — 컴파일-타임 write protection 추가. M0-b 가 이미 모든 write path 를 우회시켜 M0-d 는 거의 no-op.
- **`pane.list` envelope (M0-c)** 가 `MetadataStore.snapshot()` 으로 anchored. snapshot lineage 를 `asOfSeq` 가 반영.
- **`SessionManager` (M0-e)** 가 `metadata.json` 을 `MetadataStore` persist callback 으로 atomic write, launch 시 store 를 그 파일에서 hydrate.
- **`SCROLLBACK_DUMP` IPC 핸들러** 가 직접 `writeFileSync` 대신 `atomicWriteTextSync` 사용. rotation chain (.bak / .bak.1 / .bak.2 / .bak.3) 활성화. pre-write corruption 시그니처 검출 시 payload 거부 (defense in depth — renderer 가드 회귀 대비).
- **`SCROLLBACK_LOAD` IPC 핸들러** 가 `atomicReadTextSync` + validate hook 으로 load. chopped 시그니처 매칭 시 primary 를 `corrupted/{ts}.bak` 으로 격리 후 `.bak` 체인 fallback 으로 시도. 구조화 `CORRUPT_FILE` 로그를 stderr 로 emit. 손상 파일이 fresh xterm 에 복원돼서 다음 5초 dump 가 chopped 상태를 다시 디스크에 쓰는 자기증식 루프를 끊음.
- **`vitest.config.ts`** 가 `scripts/__tests__/**/*.test.mjs` 도 include — 운영 도구 (마이그레이션 스크립트 등) 가 같은 test runner 아래에서 회귀 보호됨.

### Fixed

- **`replaceShared` mergeMode 가 caller 의 `custom` patch 를 덮어쓰던 결함** (codex full-stack review P2) — `patch.custom` 을 silently ignore 해 tool-namespace clobber 방지. substrate 의 namespace boundary guarantee.
- **MetadataStore size cap (`PANE_METADATA_MAX_BYTES`) 이 `updatedAt` 추가 전에 검증되던 결함** (codex P2) — 최종 저장 shape (`updatedAt` 포함) 에 대해 검증. boundary 안전.
- **MetadataStore `custom` entry cap 이 patch 에만 적용되던 결함** (codex P2) — 누적 merge 가 cap 을 우회하지 못하도록 post-merge shape 에 대해 검증.
- **Split-store read-after-write hole (M0-b codex P1)** — paneId 없이 write 한 뒤 paneId 있는 read 가 stale 을 반환할 수 있던 구멍. 3 개의 metadata 핸들러 모두 `pane.resolveActiveLeaf` 로 통일.
- **`workspaceId ?? ''` 가 기억된 scope 를 덮어쓰던 결함** (M0-b codex P2) — coercion 제거; MetadataStore 의 기존 fallback 이 정상 동작.
- **스크롤백 손상 자기증식 루프 (P0 layered defense)** — hidden / zero-width 컨테이너에 대한 `fit()` 이 `cols` 를 ~2 로 collapse 시키면, renderer 의 5초 autosave 가 그 reflowed 버퍼를 캡처해 column-of-chars 로 디스크에 dump. 다음 부팅에 fresh xterm 에 복원되고 또 다시 5초 후에 dump 되며 영구적 손상 루프. 픽스는 네 층: (a) dump-time eligibility 가드 (`cols < 12` / `rows ≤ 0` / `offsetWidth === 0` / detached element), (b) font/theme-change `fit()` 의 visibility 가드 (마지막 unguarded fit 사이트 닫힘), (c) IPC `SCROLLBACK_DUMP` 의 시그니처 거부, (d) IPC `SCROLLBACK_LOAD` 의 시그니처 검출 + 격리 + `.bak` 회전 체인 fallback. 시각 증상은 "재부팅하면 일부 패널 스크롤백이 비어 보임". 자세한 forensic 은 PR #34 참조.
- **부팅 직후 일부 패널이 input-mute 였던 결함 (reconcile race)** — `daemon.whenReady()` 와 `daemon.onConnected` 가 첫 연결에 같은 reconcile 을 동시에 trigger, 두 walk 가 같은 session 에 대해 race 하면서 한쪽이 ptyId 를 clear. 사용자 증상: 부팅 후 워크스페이스 전환을 한 번 해야 일부 패널이 살아남. 픽스: `reconcileInFlightRef` 가 중복 trigger 를 drop, workspace snapshot 을 walk 마다 다시 읽어 동시 spawn 이 frozen view 에 가려지지 않음.
- **`pty:resize` 가 recovery PTY mute race 를 유발하던 결함** — daemon 이 아직 session 을 publish 하기 전에 renderer 가 보낸 `pty:resize` 가 "session not found" 로 실패하고 recovery PTY 가 muted 상태로 남던 결함. 50 × 20ms retry budget + 진단 로그 추가.
- **IPC `session` + `scrollback` 핸들러가 daemon-connect handler-swap cycle 의 unregister 윈도우에 떨어지던 결함** — cold boot 시 `scrollback:load` 가 "No handler registered" 로 거부되고 다음 5초 autosave 가 빈 버퍼를 디스크에 덮어쓰던 결함. session + scrollback 핸들러를 swap cycle 밖으로 이동.
- **logSink 의 EPIPE 무한 루프** — stdout 이 닫힌 상태에서 console.error 가 logSink 를 호출하고 logSink 가 다시 console.error 를 호출하던 reentrancy 루프. reentrancy 가드 + `orig()` try/catch 추가. `appendFileSync` 사용으로 로그가 디스크에 durable.

### Migration Notes

- **자동 마이그레이션**. 사용자 액션 불필요한 부분: substrate wire 변경 (모두 additive optional), MetadataStore 통합 (paneSlice consumer 영향 없음), atomic write + .bak rotation (v2.7.x 부터 이미 다른 파일에 적용된 패턴).
- **v2.8.x 의 chopped 스크롤백**: 첫 부팅에서 자동 격리된다. **데이터를 v2.9.0 이 버린 게 아니라 v2.8.x 시점에 이미 chopped 형태로 저장돼 있던 것을 v2.9.0 이 검출만 한 것**. 사람이 읽을 수 있는 텍스트로의 회수는 `node scripts/recover-scrollback.mjs --verbose` 로 가능 (자세한 가이드는 `docs/upgrade-v2.9.0.md`).
- **`corrupted/` 폴더**: 30 일 / 폴더당 10 파일까지 자동 정리. 수동 삭제도 안전.
- **`pane.metadata.changed` event subscriber**: optional `version` 필드가 추가됐다. 무시해도 v2.x 와 동일 동작.

## [2.8.4] — 2026-05-12 — Agent Notification Pipeline Restoration

사용자가 보고한 "Claude 가 작업을 끝내도 사이드바 dot, unread 배지, OS 토스트 — 3가지 신호 전부 안 뜬다" 결함을 root-cause 수준에서 복구. main 의 감지 레이어 (PTYBridge, AgentDetector, ActivityMonitor) 가 emit 하는 신호를 renderer UI 까지 연결하는 wiring 이 4 군데 끊겨 있었고, **wmux production 인 daemon mode 에서는 PTYBridge 가 아예 우회되어 본 fix 가 0 효과** 라는 더 큰 결함도 포함. 메인은 PR #30 (4 commits, +1579/-141, 29 files) 이고, 같은 릴리즈에 두 개의 다른 PR — **#28 (@dev-minggyu, workspace drag reorder 복구 — 외부 기여 첫 컨트리뷰션)** 과 **#29 (multiview sticky group + MiniSidebar feature parity)** — 도 함께 ship 됐다.

### Fixed

- **Workspace 드래그 정렬이 동작하지 않던 결함 (#28, @dev-minggyu — 외부 기여 첫 컨트리뷰션)** — 좌측 사이드바의 전역 파일-드롭 핸들러가 내부 워크스페이스 드래그 이벤트까지 OS 파일 드롭처럼 처리하면서 `move` 드래그가 충돌해 정렬이 막혀 있었다. 신규 `src/shared/dragDrop.ts` 헬퍼가 `DataTransfer` 가 실제 OS 파일 드래그인지 판별, 전역 드롭 핸들러와 오버레이가 파일 드래그에만 반응하도록 제한. 내부 `text/plain` 드래그 회귀 테스트 21 라인 추가.
- **Multiview sticky group + MiniSidebar feature parity (#29)** — 사용자가 보고한 multiview 3개 결함을 묶어 수정. (a) Ctrl-click 순서 무시되고 grid 가 항상 workspace 배열 순서로 렌더되던 결함 → `AppLayout` 이 `multiviewIds` 자체를 iterate 해서 Ctrl-click 순서 보존. (b) 그룹 밖 workspace 를 plain-click 하면 그룹이 통째로 사라지던 결함 → `setActiveWorkspace` 가 `multiviewIds` clear 안 함 + `activeWorkspaceId ∈ multiviewIds` 일 때만 grid 렌더 (그룹 외부 클릭 시엔 단일 view, 멤버 재클릭 시 grid 복구). (c) 접힌 사이드바 (MiniSidebar) 가 multiview indicator / drag-reorder / W1·W2 라벨 / unread 배지 / agent dot 전부 없던 결함 → 펼친 사이드바와 동일 기능 부여, `AGENT_STATUS_ICON` 을 `Sidebar/agentStatusIcon.ts` 로 추출해 두 사이드바 lockstep. Codex review 가 잡은 reseed 결함 (stale 그룹에서 새 multiview 시작 시 Ctrl-click 무반응) 도 함께 수정. +5 multiview 회귀 테스트.
- **AgentDetector status event 가 아무에게도 listen 되지 않던 결함** — `src/main/pty/PTYBridge.ts:207` 가 `agentDetector.onCritical` 만 구독하고 `onEvent` 는 dead code. Claude/Codex/Aider 의 "esc to interrupt" / "shift+tab to cycle" / "Applied edit to" 같은 정확한 prompt 패턴은 감지되어 emit 되었지만 호출되는 콜백이 0 개라 사이드바 dot 이 영영 켜지지 않았다. PTYBridge 가 `onEvent` 도 구독하도록 추가, `IPC.METADATA_UPDATE` 로 `agentStatus`/`agentName` broadcast + `sendNotification` 호출.
- **`IPC.NOTIFICATION` payload shape 가 sender 마다 달라서 외부 RPC 알림이 깨지던 결함** — `PTYBridge` 는 `(channel, ptyId, notification)` 3-arg, `notify.rpc.ts` 는 `(channel, { title, body, type })` 1-arg. preload `notification.onNew` 는 3-arg signature 라 RPC path 의 첫 인자가 ptyId 자리로 들어가 payload 가 silent 하게 깨졌다. 새 `sendNotification` utility (`src/main/notification/sendNotification.ts`) 가 단일 `(window, ptyId|null, payload)` contract 로 통일.
- **`IPC.METADATA_UPDATE` 가 두 sender 사이에 shape 불일치였던 결함** — `metadata.handler` 는 `(ptyId, data)` 2-arg, `meta.rpc` 는 `(payload)` 1-arg 로 같은 채널에 송신. 한 path 가 정상 동작하는 동안 다른 path 가 silent 하게 깨졌다. `MetadataUpdatePayload` (`src/shared/types.ts`) 를 단일 discriminated payload 로 정의, `broadcastMetadataUpdate` utility 로 모든 sender 통일. meta.rpc 의 `{kind: 'status'|'progress'}` discriminator 폐기, workspace-level field 로 직접 매핑.
- **WorkspaceMetadata.agentStatus 가 자동으로 'idle' 로 복귀하지 않던 결함** — `'waiting'`/`'complete'`/`'running'` 이 한 번 set 되면 lifecycle reset 없음. 사용자 입력 후 agent 가 다시 실행되어도 dot 은 `'waiting'`, PTY 가 죽어도 dot 은 `'running'` 으로 남는 거짓말 발생. ActivityMonitor 의 새 `onActive` 콜백이 burst 진입 시점에 `'running'` 설정, `PTYBridge.onExit` 가 `'idle'` broadcast, `cleanupInstance` 도 dispose path 에서 동일하게 broadcast (idempotent). renderer 의 `AppLayout` 가 session restore 직후 모든 workspace 의 stale agentStatus 를 sanitize.
- **Daemon mode 에서 알림 wiring 이 통째로 빠져 있던 결함 (production blocker)** — wmux 의 production normal 은 daemon mode. PTY output 은 `DaemonPTYBridge` 를 통과하고 `PTYBridge` 는 우회된다. `DaemonPTYBridge` 가 이미 `'agent'`/`'critical'`/`'idle'` event 를 emit 하고 있었지만 `DaemonSessionManager` 는 `'idle'` 만 forward, `daemon/index.ts` 는 `'activity.idle'` 만 broadcast, `DaemonClient` 는 `'session.died'` 만 specific emit. 즉 local mode fix 만으로는 사용자 환경에서 0 효과. 신규 `DaemonNotificationRouter` (`src/main/notification/DaemonNotificationRouter.ts`) 가 daemon broadcast event 5 종 (`session:agent`/`active`/`critical`/`idle`/`died`/`destroyed`) 을 listen 해서 PTYBridge 와 동일한 로직 실행. `DaemonEvent` type 에 `'activity.active'` + `'session.destroyed'` 추가, `daemon/index.ts` 가 신규 type 모두 broadcast, `DaemonClient` 가 specific emit. daemon 측 `AgentDetector` 의 dedup state 도 onActive burst 시점에 in-process 로 reset (main 에서 daemon process 의 detector 에 접근 불가하기 때문).
- **PTY echo / SIGWINCH redraw 가 false-positive idle 알림을 유발하던 결함 (사용자 발견)** — 7-round review pipeline (CEO + Eng + Codex × 4 + Claude subagent) 가 catch 못 한 케이스. ActivityMonitor 는 byte count 휴리스틱이라 "agent task ending" 과 "외부 상태 변화로 인한 PTY redraw" 를 구분 못 함. (a) 사용자 keystroke 가 PTY echo 로 돌아와 active threshold 를 넘기고 잠시 멈추면 "Task may have finished" 가 사용자 입력 중에 발화. (b) workspace 전환 시 `FitAddon.fit()` → `IPC.PTY_RESIZE` → SIGWINCH → TUI agent 의 full-screen redraw 가 active 진입 → 5s 후 idle timer 발화. 신규 `idleSuppression` 모듈 (`src/main/notification/idleSuppression.ts`) 이 `lastResizeAt`/`lastUserWriteAt` 을 per-ptyId 로 추적, 30 s window 내면 activity-fallback 알림 suppress. AgentDetector 의 precise event 는 gate 안 함 (정확한 신호이므로). `pty.handler.ts` 의 4 path (write × 2 + resize × 2) 가 `markResize`/`markUserWrite` 호출. 사용자가 보고한 "타자 치는 중 알람" + "워크스페이스만 눌렀다가 다른 곳 가면 +1" 두 시나리오 모두 해결.
- **사용자가 보고 있는 surface 에도 알림이 누적되던 결함** — `useNotificationListener` 가 active workspace 의 active surface 일치 여부 체크 없이 무조건 `addNotification` + `pushToast` 호출. 사용자가 직접 보고 있는 곳은 알림 의미 0 인데 unread 배지가 계속 올라갔다. 알림 발생 직전 `isActivePtySurface` 체크 → 일치하면 in-app surface (`addNotification` + `pushToast`) skip. OS toast 는 `ToastManager` 가 자체 focus gate 가지고 있어 변경 없음.
- **workspace 전환만으로는 unread 가 read 처리 되지 않던 결함** — 사용자 보고: "워크스페이스만 눌러서 들렀다가 다른 곳 가면 unread 가 +1." Pane click 만이 markRead 트리거였고 sidebar 의 workspace 타일 click 은 read 영향 0. `workspaceSlice.setActiveWorkspace` action 이 해당 workspace 의 모든 unread 를 read 로 자동 처리하도록 변경. `Array.isArray(state.notifications)` 가드로 workspaceSlice 단독 테스트 호환.
- **pushToast 가 사용자 toast 설정 무시하던 결함** — `useNotificationListener` 가 settings 의 `toastEnabled` 무시하고 매번 in-app overlay 띄움. 사용자가 "Toast notifications" 끄면 OS toast 만 suppress, in-app 은 그대로 표시되던 결함. `state.toastEnabled` gate 추가 (sound playback 패턴과 동일).
- **AgentDetector 의 Claude `esc to interrupt` 가 false-positive 'waiting'** — 실제로는 "지금 response 가 진행 중, ESC 로 중단 가능" 힌트이지 idle 신호가 아니다. 패턴 제거. mid-turn 에 잘못된 알림 fire 차단.
- **AgentDetector enum 명명 불일치** — `AgentEvent.status: 'completed'` vs `WorkspaceMetadata.agentStatus: 'complete'`. `AgentStatus` enum 으로 통일 (Aider 패턴 `'completed'` → `'complete'` 텍스트 변경 포함). 외부 consumer 없어 안전.
- **AgentDetector dedup 이 turn N+1 의 같은 prompt 를 영영 차단하던 결함** — `lastEmittedKey` 가 single global string 이라 한 번 emit 한 prompt 는 다시 emit 안 됨 → 사용자가 추가 입력해도 사이드바 dot 갱신 0. `lastEmittedFor` Map 으로 per-(agent:status) 분리 + `resetEmissionState()` method 추가, ActivityMonitor 의 새 active burst 시점에 reset (turn boundary). local mode 는 PTYBridge 가 직접 호출, daemon mode 는 `DaemonPTYBridge.onActive` 콜백이 in-process 에서 호출.
- **AgentDetector 의 ANSI strip 이 private-mode prefix 를 못 잡던 결함** — `\x1b[?25h` 같은 cursor visibility 시퀀스 (`?` 포함) 가 `[0-9;]*[a-zA-Z]` regex 와 안 맞아 `clean` 에 잔존, gate 매칭 실패 가능. `[0-9;?<=>]*[a-zA-Z@]` 로 확장.
- **AgentDetector 가 lone `\r` redraw 를 한 라인으로 처리하던 결함** — Claude/Codex TUI footer 는 CR 단독으로 redraw. `split(/\r?\n/)` 가 통째로 묶어 line-anchored regex 가 매칭 실패. `split(/\r?\n|\r(?!\n)/)` 로 확장.
- **AgentDetector.onEvent/onCritical 이 unsubscribe 안 돌려주던 결함** — `void` 반환이라 PTY recycle 시마다 listener 누적. v2.7.2 의 PlaywrightEngine CDP 세션 누수와 동일 카테고리. unsubscribe 함수 반환으로 변경, PTYBridge `cleanupInstance` + DaemonPTYBridge `cleanup` 에서 호출. ActivityMonitor 의 `onActiveToIdle`/`onActive` 도 같은 패턴.
- **AgentDetector callback 내부 throw 가 후속 라인 감지를 죽이던 결함** — PTYBridge middleware 패턴과 일치시켜 onEvent/onActive 콜백 본문에 try/catch 가드 추가. 한 callback 의 실패가 PTY stream 전체를 죽이지 않게 격리.
- **`AGENT_EVENT_SUPPRESSION_MS` 로 ActivityMonitor 의 fallback 알림 dedup** — AgentDetector 가 precise event emit 직후 ActivityMonitor 가 또 idle 발화하면 같은 turn 에 알림 2 회. PTYBridge / DaemonNotificationRouter 가 `lastAgentEventAt` 추적, 10 s 이내면 fallback skip.
- **`notify` RPC 가 workspaceId 없이는 깨지던 결함** — preload signature 가 `ptyId: string` 강제, `addNotification` 이 `surfaceId` 강제. RPC path 는 ptyId 가 없어 silent drop 되거나 type error. workspaceId optional 로 변경 (CLI `wmux notify` backward compat 유지), `Notification.surfaceId` optional, useNotificationListener 가 `null` ptyId 면 workspaceId 로 active surface resolve (or active workspace fallback).

### Added

- **`sendNotification` utility** (`src/main/notification/sendNotification.ts`) — 모든 `IPC.NOTIFICATION` 송신의 단일 entry point. window null/destroyed 가드 + `(ptyId | null, payload)` 시그니처 통일. PTYBridge 4 호출 지점 + notify.rpc + DaemonNotificationRouter 모두 import.
- **`broadcastMetadataUpdate` utility** (`src/main/ipc/handlers/metadata.handler.ts`) — 모든 `IPC.METADATA_UPDATE` 송신의 단일 entry point. MetadataUpdatePayload 단일 shape.
- **`idleSuppression` 모듈** (`src/main/notification/idleSuppression.ts`) — per-PTY resize/user-write 시점 추적. 30 s suppression window 로 ActivityMonitor 의 byte-count heuristic false-positive 차단.
- **`DaemonNotificationRouter`** (`src/main/notification/DaemonNotificationRouter.ts`) — daemon mode 에서 PTYBridge 의 알림 라우팅 역할 대체. `DaemonClient` event 5 종 listen → `sendNotification` + `broadcastMetadataUpdate` + toast.
- **AgentDetector 의 in-process API 확장** — `getActiveAgents()` / `getLastAgent()` / `resetEmissionState()` public method 추가. PTYBridge 가 lastAgent name 을 onActive metadata 에 채워 넣을 수 있게.
- **37 신규 unit test** — `AgentDetector.test.ts` (18, enum/unsubscribe/dedup/`\r` split/ANSI strip/getters/critical), `ActivityMonitor.test.ts` (+4, onActive cycle dedup), `sendNotification.test.ts` (4, null/destroyed/ptyId 분기), `PTYBridge.notify.test.ts` (5, METADATA_UPDATE + NOTIFICATION + try/catch + cleanup unsub), `notify.rpc.test.ts` (6, workspaceId optional + MCP path + type fallback + toast). IRON RULE 7 regression 중 6 cover, R7 (pushToast in renderer) 는 jsdom 필요해 manual.

### Migration Notes

- 자동. 사용자 액션 불필요.
- `Notification.surfaceId` 를 optional 로 변경 — `Pane.tsx` 의 `surfaceIds.has(n.surfaceId)` 에 undefined guard 추가됨. 다른 consumer 없음.
- `AgentEvent.status` enum 변경 (`'completed'` → `'complete'`) — wmux 내부에서 PTYBridge `onCritical` 만 consume 했고 onEvent 는 dead code 였으므로 외부 영향 없음.
- `IPC.METADATA_UPDATE` payload shape 통일 — preload `metadata.onUpdate` 시그니처가 `(payload)` 단일 인자로 변경. renderer 의 `useNotificationListener` 가 호환 처리. 외부 MCP / CLI consumer 영향 없음.
- `notify` RPC 의 `workspaceId` 는 optional 신규 param. CLI `wmux notify --title X --body Y` 는 그대로 동작. MCP 클라이언트가 `mcp.claimWorkspace` 의 workspaceId 를 함께 보내면 precise routing (active surface auto-select).

### Deferred (follow-up issues)

- `DaemonNotificationRouter` regression test suite — manual verification 으로 cover, daemon IPty pipeline mock 은 별도 작업.
- session-restore sanitize regression test — session fixture builder 필요.
- `onExit` elapsed=0 cosmetic (cleanupInstance 가 ptyCreatedAt 먼저 wipe 하는 path) — purely message-text, behavioural 영향 0.
- `DaemonClient.removeAllListeners` on disconnect — pre-existing, 본 PR 범위 외.
- `TODOS.md` 에 cherry-picked deferral 추가: E3 (transient dot flash animation, P3), E4 (per-workspace notification mute, P2), E5 (tray icon unread badge — cross-platform, P2), Phase 2 Eureka (Claude Code stop-hook → OSC 9 BEL emit, P3).

### Review Trail

| Pass | Reviewer | Findings | Status |
|---|---|---|---|
| Plan 1 | `/plan-ceo-review` | 5 proposals | SELECTIVE_EXPANSION, 2 accepted |
| Plan 1 | Codex round 1 | 10 | all addressed |
| Plan 1 | `/plan-eng-review` | 11, 1 critical | all addressed |
| Plan 1 | Codex round 2 | 8 | all addressed (daemon mode wiring 6 파일 추가) |
| Code 2 | Codex round 3 | 2 (P1+P2) | all addressed in `5aee27f` |
| Code 3 | Codex round 4 | 3 (P2+P2+P3) | all addressed in `cddd3bd` |
| Code 3 | Claude subagent | 7 (P2+P2+P3×5) | 2 addressed, 5 deferred |
| Code 4 | 사용자 manual test | 2 (resize/typing FP) | addressed in `42f5bd3` |

7-round review pipeline 의 한계: AI review 가 PTY echo / SIGWINCH redraw 같은 **runtime 동작** 은 코드만 보고 모델링하기 어렵다. 사용자 manual test 가 마지막 안전망이 됐다는 점이 기록 가치 있음.

## [2.8.3] — 2026-05-11 — License Bundling + Third-Party Notices Attribution

wmux 빌드 산출물에 부족했던 attribution 의무를 정리한 patch. `THIRD_PARTY_NOTICES` 가 Playwright 하나만 적혀 있었지만 실제 runtime 번들은 **110 packages** (16 직접 deps + Electron + ~93 transitive) 를 포함하고 있었다. MIT/ISC/BSD/Apache-2.0 의 "all copies or substantial portions" 조항을 모두 충족하도록 재구성. 코드 동작 변경 없음 — 사용자 가시 변경은 tray 메뉴에 라이선스 진입점 3 개 신설.

### Added

- **자동 생성 스크립트 `scripts/generate-notices.mjs`** — `npm run notices` 로 production deps tree 전체를 walk 해서 `THIRD_PARTY_NOTICES` 를 재생성한다. 외부 의존성 0 개 (`npm ls --prod --all --json` + `node:fs` 만 사용). 추가 install 없이 CI 에서도 그대로 실행 가능. dependency 변경 시 즉시 갱신.
- **Tray 컨텍스트 메뉴 라이선스 진입점 3 개** — `About wmux` (네이티브 About 패널), `License (wmux)` (MIT 본문 직접 열기), `Third-party licenses` (`THIRD_PARTY_NOTICES` 직접 열기). `shell.openPath` 로 OS 기본 텍스트 앱에서 열고, 연결된 앱 없으면 `showItemInFolder` fallback. 그동안 wmux 는 application menu 자체가 없어서 사용자가 라이선스 파일에 도달할 경로가 0 이었다.
- **`app.setAboutPanelOptions`** — 네이티브 About 다이얼로그에 wmux 버전 / MIT copyright pointer / project URL metadata 설정. macOS 는 앱 메뉴에서 자동 표시, Windows/Linux 는 신규 tray 항목 "About wmux" 가 트리거.

### Fixed

- **`THIRD_PARTY_NOTICES` 의 109 packages 누락** — 이전 파일은 Playwright 1 개만 적혀 있어 사실상 MIT/ISC/BSD/Apache-2.0 attribution 의무 (carry copyright notice in "all copies") 가 부분 미준수 상태였다. 자동 생성으로 110 packages 모두 채움. 라이선스 분포: 98 MIT, 7 ISC, 2 Apache-2.0 (electron-squirrel-startup, playwright-core), 2 BSD-3-Clause, 1 BSD-2-Clause. **Zero copyleft, zero unknown** — 재배포 권리 위험 0.
- **wmux 자체 `LICENSE` 가 빌드 산출물에 누락** — `forge.config.ts` 의 `extraResource` 에 `./LICENSE` 추가. 빌드 후 `<install>/resources/LICENSE` 에 위치하여 wmux 의 MIT 본문도 exe distribution 과 함께 carry. (Electron 본체 LICENSE — Chromium / V8 / Node 커버 — 는 electron-packager 가 install root 의 `wmux.exe` 옆에 자동 emit, 이미 충족됨.)

### Migration Notes

- 자동. 사용자 액션 불필요. 외부 MCP 통합 측에 변경 없음. 빌드 자체에 영향 없는 데이터 + UI 보조 작업.

## [2.8.2] — 2026-05-11 — Session Cap Headroom + Silent-Failure Fix

@alphabeen 이 v2.8.1 출시 직후 PR #25 로 보고한 두 문제를 한 patch 에 묶는다. v2.8.1 의 startup brick 픽스 이후에도 **runtime accumulation** 시나리오 (X close 후 daemon 이 유지하는 detached 세션이 며칠에 걸쳐 누적) 에서는 hard cap 50 에 다시 도달했고, 더 나쁜 건 cap throw 가 renderer 의 `Ctrl+T` 핸들러에서 silent 하게 묻혀 단축키가 무반응처럼 보이던 결함이다. v2.8.1 사용자는 즉시 업그레이드 권장.

### Fixed

- **데몬 세션 hard cap 50 → 200 상향** — #25, @alphabeen. v2.8.0 의 세션 영속화 이후 cap 의 의미가 "한 세션 동안 최대 동시 PTY" → "lifetime 누적 detached PTY 총합" 으로 바뀐 결과, multi-workspace + 빈번한 split 사용자는 며칠 내 50 에 재도달. 50 자체는 [commit 989dd8a](https://github.com/openwong2kim/wmux/commit/989dd8a) 의 보안 하드닝 단계에서 정한 DoS 휴리스틱이었고 200 도 같은 카테고리 안. soft cap 40 (recovery) / 7-day suspended TTL 정책은 무변경. 헤드룸 10 → 160. 근본 해결 (orphan detached GC) 은 v2.9 트랙으로 별도 검토. 구현: `src/daemon/DaemonSessionManager.ts`, `src/daemon/index.ts` 주석 동기화.
- **`pty.create` rejection 이 묻혀 단축키 무반응처럼 보이던 회귀** — @alphabeen 이 PR #25 description 에서 짚어준 두 번째 문제. cap 도달 시 daemon 이 actionable 에러 (`Cannot create new terminal: 200 active sessions already running. Close some panes (or restart wmux) and try again.`) 를 throw 하는데 renderer 의 세 호출 지점 (`useKeyboard` Ctrl+T 핸들러 / `AppLayout` empty-leaf 자동 PTY / `FloatingPane` 첫 열림) 모두 `.then()` 만 달고 `.catch()` 누락 (또는 silent catch) 이라 rejection 이 묻히고 단축키가 무반응처럼 보였다. v2.8.1 Bug 1 의 actionable error 의도가 무력화되던 결함.
  - **신규 IPC 에러 코드 `RESOURCE_EXHAUSTED`** — `wrapHandler` 의 `classifyError` 가 cap 메시지 패턴 (`cannot create new terminal` + `active sessions already running`) 을 감지해 분류. 메시지에 `[RESOURCE_EXHAUSTED]` prefix 가 stamp 되어 renderer 가 분기 가능.
  - **`useIpc` 매핑** — `DEFAULT_MESSAGES['RESOURCE_EXHAUSTED']` = "터미널 세션 한도에 도달했습니다. 일부 pane을 닫거나 wmux를 재시작한 뒤 다시 시도해주세요.", level `'warn'`. UNKNOWN 으로 매핑되어 generic "알 수 없는 오류" 토스트가 뜨던 path 차단.
  - **세 호출 지점 모두 `ipcInvoke` wrap 으로 통일** — `useKeyboard` Ctrl+T (ref 패턴으로 once-on-mount effect 안에서 사용), `AppLayout` empty-leaf 자동 PTY effect, `FloatingPane` 첫 PTY 생성. 모두 `result.ok` 분기 + 실패 시 toast 자동 게재.
  - **Electron invoke envelope wrap 처리** — codex P2 review 에서 잡힌 결함. `ipcRenderer.invoke` 가 main side 에러를 renderer 로 전달할 때 메시지를 `Error invoking remote method 'X': Error: <orig>` 형태로 감싸서, `useIpc` 의 `MESSAGE_CODE_PREFIX` 가 `^` anchor 였던 탓에 `[RESOURCE_EXHAUSTED]` stamp 가 envelope 뒤로 밀려 매칭 실패 → 모든 coded error 가 다시 UNKNOWN 으로 떨어지던 path 차단. renderer regex 만 anchor 제거 (main side 는 자기 raw output 매칭이라 anchor 유지). 알phabeen 이 PR #25 description 에서 짚어준 결함이 두 번 일어나지 않도록 회귀 테스트 추가.
  - 구현: `src/main/ipc/wrapHandler.ts`, `src/renderer/hooks/useIpc.ts`, `src/renderer/hooks/useKeyboard.ts`, `src/renderer/components/Layout/AppLayout.tsx`, `src/renderer/components/Terminal/FloatingPane.tsx`. 6 unit tests 추가 (wrapHandler RESOURCE_EXHAUSTED classification + message prefix stamping + useIpc default 매핑 + Electron-wrapped envelope classification).

### Migration Notes

- 자동. 클라이언트 / 외부 MCP 통합 측에 변경 없음. 신규 `RESOURCE_EXHAUSTED` 코드는 내부 IPC 경계 안쪽에서만 사용 (renderer ↔ main).

## [2.8.1] — 2026-05-10 — Session Recovery Stability Hotfix

@alphabeen 이 v2.8.0 출시 직후 보고한 세 가지 회귀 — 시간이 갈수록 wmux 가 사용 불가 상태로 빠지던 critical, recovered pane 출력이 깨지던 high, 매 시작마다 generic 에러 토스트가 뜨던 medium — 을 한 릴리스에 묶어 수정한다. v2.8.0 사용자는 즉시 업그레이드 권장 — 자동 마이그레이션이 누적된 `sessions.json` 을 첫 실행 시 정리한다.

### Fixed

- **세션 누적으로 인한 brick 상태 (Critical)** — v2.8.0 에서 도입된 데몬 세션 영속화는 사용자가 X 로 종료한 모든 live pane 을 `suspended` 로 저장하고 다음 시작 시 복구한다. 그런데 (1) 복구 횟수에 상한이 없었고, (2) 종료 시점에 사용자가 명시적으로 닫지 않은 세션은 영원히 `sessions.json` 에 남아 누적됐다. 4–5 회 재시작이면 데몬의 하드 PTY 캡 (`MAX_SESSIONS=50`) 을 모두 소진하여 startup recovery 가 새 pane 슬롯을 못 만들고, UI 는 `Ctrl+T` 도 안 먹히고 generic "알 수 없는 오류" 토스트만 도배되는 상태에 빠진다. 자가복구 불가능 (재시작해도 같은 시나리오 반복).
  - **Suspended 7-day TTL** — `StateWriter.load` 가 이제 dead 세션뿐 아니라 7 일 이상 inactive 한 suspended 도 함께 prune. v2.8.0 에서 누적된 기존 `sessions.json` 도 첫 v2.8.1 실행 시 자동 정리된다.
  - **Recovery soft cap 40** — 신규 `MAX_RECOVER_SESSIONS=40`. 복구 후보를 `lastActivity` 내림차순 정렬해 상위 40 개만 PTY 로 재생성하고 나머지는 그대로 suspended 로 남는다. 다음 launch 에서 활성 카운트가 줄면 자동으로 복구 후보에 다시 들어오며, 7 일 TTL 이 그래도 정체된 것을 reap. 이로써 hard cap 50 에 도달해도 항상 신규 pane 헤드룸 10 슬롯이 보장된다.
  - **`createSession` 에러 메시지 사용자 친화적 변경** — `Maximum session limit (50) reached` → `Cannot create new terminal: 50 active sessions already running. Close some panes (or restart wmux) and try again.`. RPC 응답으로 그대로 노출되어 향후 토스트가 generic 이 아닌 actionable 메시지로 보임.
  - 구현: `src/daemon/StateWriter.ts`, `src/daemon/index.ts`, `src/daemon/DaemonSessionManager.ts`, `src/daemon/recoverySelector.ts` (신규 — pure 함수로 cap 정책을 분리해 unit-test 가능). 9 unit tests 추가.

- **복구된 pane 출력 interleave (High)** — v2.8.0 은 종료 시점의 PTY cols/rows 를 저장하고 복구 시 그 값으로 ConPTY 를 spawn 한다. 사용자가 윈도우 사이즈를 바꾸고 재시작하면 ConPTY 는 옛 geometry 로 출력하는데 xterm 은 새 geometry 로 그려서 같은 줄에 두 paint 의 문자가 interleave 된다 (예: `Accessing workspace:` → `Accessingwworkspace:`).
  - **Deferred output mode** — `DaemonPTYBridge` 에 `setMuted(bool)` 추가. recovery 경로에서 `createSession({deferOutput: true})` 면 bridge 가 muted 로 시작하여 PTY 데이터 path 가 ring buffer 에 쓰지 않는다 (exit 알림은 muted 와 무관하게 정상 동작). renderer 가 첫 `daemon.resizeSession` 을 호출하면 PTY 가 진짜 geometry 로 resize 되고 `DEFERRED_UNMUTE_DELAY_MS=100` 후 자동 unmute. ConPTY 가 옛 geometry 에서 큐잉했던 출력은 100 ms 동안 drain 되고 버려진다. 저장된 scrollback (buffer dump) 은 ring buffer 에 직접 pre-fill 되므로 muted path 와 무관하게 보존된다.
  - 구현: `src/daemon/DaemonPTYBridge.ts`, `src/daemon/DaemonSessionManager.ts`, `src/daemon/index.ts` (recoverSessions 의 createSession 호출 3 곳 모두 `deferOutput: true`). 5 unit tests 추가 (drop while muted / scrollback 보존 / resize-then-unmute / 비-deferred regression / muted 중 exit 발화).

- **시작 시 generic 에러 토스트 폭주 (Medium)** — main process 가 daemon connect 를 비동기로 시도하는 동안 renderer 가 이미 IPC 호출을 던져, handler swap (`cleanupHandlers()` → `registerAllHandlers(...)`) 의 sub-millisecond 무등록 윈도우에 떨어진 호출이 `No handler registered for ...` 로 실패해 `useIpc` 가 `UNKNOWN` → "알 수 없는 오류가 발생했습니다." 토스트를 5–10 회 띄우던 문제.
  - main 이 단일 IPC handler `daemon:get-ready-state` 를 등록 (registerAllHandlers swap cycle 바깥이라 무등록 race 불가). connect 시도가 끝나면 `markDaemonReady()` 가 그동안 큐잉된 invoke 를 해제. 이후 invoke 는 즉시 현재 `daemonClient` 상태로 응답.
  - preload 의 `electronAPI.daemon.whenReady()` 가 `ipcRenderer.invoke('daemon:get-ready-state')` 를 호출 (one-shot event 가 아니라 query). renderer crash recovery 의 `mainWindow.reload()` 로 새로 로드된 preload 인스턴스도 정상 응답을 받아 deadlock 안 됨 (codex review fix — 초기 event-based 설계의 P2 결함 보강).
  - `AppLayout` 의 첫 reconcile 이 `daemon.whenReady()` 를 await 하여 handler 가 안정된 뒤에야 `pty.list` / `pty.reconnect` 를 호출. 토스트 폭주 사라짐.
  - 구현: `src/main/index.ts`, `src/preload/preload.ts`, `src/renderer/components/Layout/AppLayout.tsx`.

- **Split 후 빈 pane 이 영구 placeholder 로 남던 문제** — `AppLayout` 의 auto-PTY effect 가 `activeWorkspace.id` 만 deps 로 가져 split 으로 추가된 새 leaf 가 `surfaces=[]` 인 채 effect 재실행을 유발하지 못했다. 결과적으로 분할된 새 pane 이 "빈 창" placeholder 로 굳어 PTY 가 영영 안 붙었다. `collectEmptyLeaves` 를 effect 바깥으로 끌어올리고 빈 leaf id 들의 join 키를 deps 에 추가해 split 이 즉시 PTY 생성을 트리거하도록 수정. paneSlice 에 회귀 테스트 추가 (`src/renderer/stores/slices/__tests__/paneSlice.test.ts`).

- **한글 IME 상태에서 Ctrl+D / Ctrl+Shift+D split 단축키 미작동** — Hangul 레이아웃에서 `e.key` 가 `'ㅇ'` 또는 `'Process'` 가 되어 useKeyboard 의 `key === 'd'` 매칭이 빗나가고, useTerminal 의 xterm allowlist 도 같은 이유로 빠져 단축키가 xterm 에 흘러갔다. 두 곳 모두 `e.code === 'KeyD'` (물리 키 코드) 도 함께 매칭하도록 수정 — 기존 Ctrl+B / Ctrl+M 등의 cross-layout 패턴과 일관. 구현: `src/renderer/hooks/useKeyboard.ts`, `src/renderer/hooks/useTerminal.ts`.

- **분할 pane 을 키보드/마우스로 닫을 수 없던 문제** — Ctrl+W 가 `closeSurface` 만 호출해 마지막 surface 닫혀도 pane 이 collapse 안 되고, 단일 surface pane 에서는 `SurfaceTabs` 가 strip 자체를 숨겨 X 버튼도 없었다. (1) Ctrl+W 가 마지막 surface 닫힐 때 `closePane` cascade 호출 (Pane.tsx X-button 동작 미러), (2) `SurfaceTabs` 가 surfaces.length === 1 이어도 strip 렌더, (3) 신규 Ctrl+Shift+Q (tmux kill-pane equivalent) 추가 + `BUILTIN_KEYS` 로 보호, (4) SettingsPanel 의 Ctrl+W 라벨이 실제 동작과 어긋났던 것을 closeSurface / closePane 두 줄로 분리해 i18n 4개 로케일 (en/ko/ja/zh) 모두 수정. 구현: `src/renderer/hooks/useKeyboard.ts`, `src/renderer/components/Pane/SurfaceTabs.tsx`, `src/renderer/components/Settings/SettingsPanel.tsx`.

- **Reconnect 후 출력이 두 줄로 중복되던 문제** — `pty.handler.ts` 의 `PTY_CREATE` 와 `PTY_RECONNECT` 가 매번 새 `daemonClient.on('session:data', listener)` 를 등록하면서 이전 listener 를 떼지 않아 누적됐다. 한 세션을 reconnect 한번만 해도 두 listener 가 같은 chunk 를 두 번 forward 해 renderer xterm 에 중복 출력. per-session listener map 으로 분리하여 같은 ptyId 의 이전 listener 를 항상 정리한 뒤에만 새 listener 등록. 구현: `src/main/ipc/handlers/pty.handler.ts`.

### Migration Notes

- 자동. 첫 v2.8.1 실행 시 `StateWriter.load` 가 7 일 이상 묵힌 suspended 세션을 prune 한다. 추가 액션 불필요. v2.8.0 에서 이미 brick 된 사용자도 업그레이드 후 첫 실행에서 정상 복구된다 (alphabeen 이 가이드한 수동 `sessions.json`/`daemon-pipe`/`daemon.lock`/`daemon.pid` 삭제 절차는 더 이상 필요 없음).
- 외부 MCP 통합 측에 변경 없음 — 모든 변경은 daemon 내부 + main↔renderer IPC 가드.

## [2.8.0] — 2026-05-09 — External Tooling Surface + Cross-Pane Search

외부 AI 도구(Claude Code, 서드파티 MCP)가 wmux 위에 워크플로우를 빌드할 수 있도록 세 개의 신규 surface를 동시 도입한 minor 릴리스다. @alphabeen 의 RFC #15 가 직접적인 트리거이며, 그 결과로 (1) pane 단위 metadata API, (2) cursor 기반 JSON-RPC event bus, (3) cross-pane search 가 묶음으로 들어온다. 모든 신규 필드는 optional 이라 기존 클라이언트는 영향 없으며, `system.capabilities().features` 의 새 키 (`paneMetadata`, `events`) 로 신규 표면을 감지할 수 있다.

릴리스 본문이 큰 만큼 데이터 마이그레이션은 없다. 다만 외부 MCP 통합 코드를 작성한 사람은 "Migration Notes" 의 `bootId` / `asOfSeq` 항목을 한 번 읽고 캐시 무효화 경로를 확인할 것.

### Added

- **Pane metadata API** — #16. `PaneLeaf` 에 optional `PaneMetadata { label?, role?, status?, custom?: Record<string,string>, updatedAt? }` 부착. RPC 3 개 (`pane.setMetadata`/`getMetadata`/`clearMetadata`) + MCP tool 2 개 (`pane_set_metadata`, `pane_get_metadata`). 8 KB 직렬화 캡, label ≤ 64, role ≤ 64, status ≤ 128, custom ≤ 32 entries × 64-char keys. 외부 MCP 의 cross-workspace 하이재킹은 `workspaceId` 자동 스코프 + slice 레벨 검증으로 차단 (v2.7.2 `mcp.claimWorkspace` fix 와 같은 클래스 패턴). `custom` 맵은 `merge=true` 일 때 1 단계 deep-merge — 협력하는 두 MCP 가 서로의 키를 덮어쓰지 않는다.
  구현: `src/shared/types.ts`, `src/shared/rpc.ts`, `src/main/pipe/handlers/pane.rpc.ts`, `src/renderer/stores/slices/paneSlice.ts`, `src/renderer/hooks/useRpcBridge.ts`, `src/mcp/index.ts`.

- **JSON-RPC event bus** — #21 (resubmit of #17, base-deleted artifact). `WmuxEventType` union: `pane.created` / `pane.closed` / `pane.focused` / `pane.metadata.changed` / `workspace.metadata.changed` / `process.started` / `process.exited`. In-memory ring (1024 events) + monotonic `seq` cursor. RPC `events.poll({cursor, types?, workspaceId?, max?})` + MCP tool `wmux_events_poll`. 외부 도구는 자기 워크스페이스 이벤트만 자동 스코프. `bootId` (UUIDv4 / EventBus 인스턴스마다 변경) 가 `events.poll` / `system.capabilities` / `pane.list` 응답에 모두 노출되어 데몬 재시작 시 클라이언트 캐시(pane id, pty id, cursor) 를 깨끗이 무효화할 수 있다. `pane.list` 는 envelope `{asOfSeq, bootId, panes}` 로 변경되어 resync 후 reconcile 의 frame of reference 를 명확히 한다. polling 만 — push/SSE 는 stdio MCP transport 와 안 맞아 deferred.
  구현: `src/shared/events.ts`, `src/main/events/EventBus.ts`, `src/main/pipe/handlers/events.rpc.ts`, `src/renderer/events/publisher.ts`, `src/renderer/stores/slices/searchSlice.ts`.

- **Cross-pane search** — #20. wmux 의 첫 cross-pane primitive. `Ctrl+F` 의 "All Panes" 토글로 현재 워크스페이스 모든 live pane 의 xterm.js 버퍼를 on-demand grep 한다. 결과 ≤ 10 개는 search bar dropdown, > 10 개는 하단 panel 자동 확장 (progressive disclosure UX with hysteresis: open at > 10, close at ≤ 5, sticky bit until session reset). 결과 클릭 → 해당 pane focus + `scrollToLine(physicalBaseY)` 로 wrapped line 까지 정확히 jump. regex 모드 + 잘못된 패턴 visual error (red border + tooltip, no toast). MCP tool `wmux_search_panes(query, regex?)` 로 외부 AI 도 자율 추론 가능 ("JWT 에러 단 pane" 같은). 200-result cap, 20k lines/pane scan cap, 500-char line truncation. cross-workspace 검색은 v2 deferred (RPC-layer caller-identity gate 추가 설계 필요).
  구현: `src/renderer/utils/searchEngine.ts`, `src/renderer/components/Terminal/SearchBar.tsx`, `src/renderer/components/Search/SearchResultsPanel.tsx`, `src/renderer/stores/slices/searchSlice.ts`, `src/mcp/index.ts`. i18n: en/ko/ja/zh 4 locale 모두 신규 키 추가.

### Changed

- **`pane.list` 응답 형태** — `PaneListEntry[]` → `{asOfSeq: number, bootId: string, panes: PaneListEntry[]}` envelope. resync 시 클라이언트가 "이 스냅샷 이후 events" 를 정확히 결정할 수 있다. `panes[]` 는 기존 키 그대로 + 새 `metadata?: PaneMetadata` 필드 추가. 기존 클라이언트는 envelope unwrap 후 `.panes` 만 사용하면 되며, `metadata` 는 optional 이라 무시해도 됨.

- **`system.capabilities` 응답 확장** — `methods: RpcMethod[]` 만 있던 응답에 `features: { paneMetadata: true, events: { types, maxRingSize, bootId } }` 추가. 기존 `methods` 배열은 변경 없이 신규 method 들이 자동 추가된다 (`'pane.setMetadata'`, `'pane.getMetadata'`, `'pane.clearMetadata'`, `'pane.search'`, `'events.poll'`).

### Security

- **Cross-workspace pane.search 누출 차단** — RPC handler 가 caller 가 보낸 `workspaceId` 를 우선 사용하고 fallback 으로만 active workspace 를 쓴다. 외부 MCP 가 자기 ws 컨텍스트로 검색 호출 시, 사용자가 다른 ws 를 보고 있어도 caller 의 ws 결과만 받는다. v2.7.2 `mcp.claimWorkspace` fix 와 동일 클래스의 보안 게이트.
- **Pane metadata cross-ws 하이재킹 차단** — `pane.setMetadata` / `pane.clearMetadata` 도 `workspaceId` 스코프 강제. 외부 MCP 가 사용자 보는 ws 에 임의 metadata 작성 불가.

### Fixed

- **Clipboard selection 잔존 fix** — #19. v2.7.4 에서 도입한 selection-preserving fit 가드가 `isVisible` useEffect 와 `document.fonts.ready` 콜백 두 곳에 누락돼 워크스페이스 전환 직후나 폰트 로드 직후 selection 이 wipe 되던 문제. 또 selection 후 명시적 Ctrl+C 사이에 PTY 출력으로 selection 이 자연 클리어되어 SIGINT 가 가던 문제. fix: 두 가드 추가 + `terminal.onSelectionChange` 기반 자동 복사 (150 ms debounce, main-IPC 경유로 1 MB cap·Win32 lock retry·error toast 모두 보존). 해당 layer 9 unit tests 추가.
  구현: `src/renderer/hooks/useTerminal.ts`, `src/renderer/utils/autoSelectionCopy.ts` (신규).

### Migration Notes

- **외부 MCP 통합 코드** 는 `wmux_search_panes` / `wmux_events_poll` / `pane_get_metadata` 등 신규 도구를 즉시 사용할 수 있다. 신규 surface 감지는 `system.capabilities().features.paneMetadata` 와 `features.events` 키로.
- **`pane.list` 호출자** 는 응답이 envelope 으로 바뀐 점을 반영해야 한다. 기존 코드가 `panes[0].id` 처럼 직접 인덱싱했다면 `result.panes[0].id` 로. 단, MCP `pane_list` tool 은 envelope 그대로 반환하므로 AI 에이전트는 자연어로 처리 가능.
- **이벤트 폴링 클라이언트** 는 매 응답의 `bootId` 를 비교하고, 변경됐다면 cached pane id / pty id / cursor 를 모두 폐기하고 `pane.list` 로 reconcile. `cursor > latestSeq()` 또는 `resync: true` 도 동일하게 처리.

### v1 deferred → v2 candidates

다음 항목들은 본 릴리스 범위 밖으로 명시 deferred — 트래킹 #18 :

- Cross-workspace search 및 metadata write (현재 caller ws 만 — explicit setting + RPC-layer caller-identity gate 설계 필요)
- Push / SSE event delivery (stdio MCP 와 어울리지 않음, 폴링 latency 가 UX 문제 될 때 재검토)
- Dead session scrollback dump 검색 (live pane 만 v1)
- Optimistic concurrency (`expectedVersion`) on `meta.set` — 다중 도구 contention 시 last-writer-wins 를 깨끗이 분리

## [2.7.4] — 2026-05-07 — Terminal Stability (4-bug Fix)

v2.7.0 의 UI 확장 후 누적된 터미널 안정성 4 건을 묶은 patch. 모두 사용자 가시 회귀라 우선 ship. 데이터 마이그레이션 없음.

### Fixed

- **Hang / CPU 풀가동 (큰 출력)** — `PTYBridge.ts` onData 에 8 ms micro-batch 도입. `OscParser.ts` 가 slice 기반(O(n²) → O(n)). `ActivityMonitor.ts` 가 100 ms 타임스탬프 가드.
- **Ctrl+V paste 일부 누락** — `useTerminal.ts` 의 Ctrl+V / Ctrl+Shift+V 핸들러에 4096 청킹 추가 (우클릭 path 와 동일). `pty.handler.ts` 100 K silent drop backstop 은 유지하되 `console.warn` 추가.
- **Copy 완전 안 됨** — `clipboard.handler.ts` silent return 3 건을 typed throw (`CLIPBOARD_INVALID_TYPE` / `CLIPBOARD_TOO_LARGE` / `CLIPBOARD_WRITE_FAILED`) 로 변환. 4 호출부 (useTerminal ×3 + Terminal.tsx) 가 await + try/catch, 실패 시 selection 유지 + `showCopyErrorToast` (i18n 4 locale).
- **마지막 문단만 복사** — `useTerminal.ts` ResizeObserver / font-theme effect 에 `hasSelection()` 가드 + `windowsPty: { backend: 'conpty', buildNumber: 21376 }` 옵션으로 ConPTY reflow 활성화 (xterm.js 6 의 SelectionService unconditional clear 우회).

### Changed

- `IPC.CLIPBOARD_WRITE` invoke 가 실패 시 throw — renderer 는 await + try/catch 필수.
- `IPC.PTY_DATA` 송신 빈도가 청크 단위 → 8 ms batch 단위 (데이터 내용 / 순서 동일).
- `IPC.PTY_WRITE` 100K 초과 silent drop backstop 은 유지 — renderer 가 청킹으로 회피해야 함.

### Migration Notes

스키마 변경 없음. `clipboardAPI.writeText` 를 호출하는 신규 코드는 await + try/catch 필수.

## [2.7.3] — 2026-04-28 — A2A Execute Approval Gate

외부 MCP 호출자가 `a2a_task_send` 의 `execute:true` 한 줄로 사용자의
워크스페이스에서 `--permission-mode bypassPermissions` 모드의 Claude
CLI 를 무인 실행할 수 있던 표면을 차단한 보안 patch. 단일 항목이지만
RCE 급 표면이라 즉시 출하한다. 데이터 마이그레이션 없음.

### Security

- **A2A `execute:true` 사용자 승인 게이트** — 1cd5ab3. 신규 task 가
  `execute:true` 로 들어오면 ClaudeWorker spawn 직전에 사용자에게
  확인 다이얼로그를 띄운다 — 발신/수신 워크스페이스, 작업 cwd, 메시지
  500 자 미리보기, 30 초 자동 거부 카운트다운. 거부 또는 타임아웃 시
  task 가 `canceled` 로 마크되어 발신자가 `a2a_task_query` 로 거부를
  확인할 수 있다. `cancelTask` 권한이 발신자에서 발신자/수신자로
  완화돼, 수신자가 들어오는 task 를 deny 할 수 있다.
  구현: `src/main/pipe/handlers/a2a.rpc.ts`,
  `src/main/pipe/handlers/_bridge.ts`,
  `src/renderer/components/A2a/ExecuteApprovalDialog.tsx`,
  `src/renderer/utils/executeApproval.ts`,
  `src/renderer/hooks/useRpcBridge.ts`,
  `src/renderer/stores/slices/a2aSlice.ts`.

### Migration Notes

스키마 변경 없음. 자동 마이그레이션 없음. `execute:true` 를 사용하는
기존 자동화는 이제 사람의 승인 없이는 실행되지 않으므로, 신뢰된
caller 가 무인 실행을 기대했다면 향후 도입될 `autoApproveExecute`
설정 토글을 기다리거나 `execute` 없이 호출하도록 조정한다.

## [2.7.2] — 2026-04-25 — Stability & MCP Hardening

v2.7.1 이후 누적된 안정성·보안 하드닝을 묶은 patch 릴리스다. 신규
사용자 대상 UI 기능은 없고, 데이터 마이그레이션도 필요 없다. MCP
통합을 사용하는 외부 클라이언트는 워크스페이스 점유 동작이 바뀌었으니
"Changed" 항목을 한 번 확인할 것.

### Fixed

- **Daemon mass-kill cascade** — fb65626. 한 PTY 가 비정상 종료될 때
  같은 워크스페이스의 다른 PTY 들까지 연쇄 종료되던 문제. 종료 사유를
  per-PTY 로 분리해 cascade 트리거를 차단했다.
  구현: `src/daemon/SessionManager.ts`, `src/daemon/PtySupervisor.ts`.
- **PlaywrightEngine CDP 메모리 누수** — df37e97. `mcp__wmux__browser_*`
  툴 호출 후 CDP 세션이 detach 되지 않아 장시간 사용 시 RAM 이 단조
  증가하던 문제. 페이지 lifecycle 에 detach 를 묶었다.
  구현: `src/main/browser/PlaywrightEngine.ts`.
- **PWSH non-zero exit code 보고** — 83d584e. OSC 133 hook 이 항상 0 을
  보고해 shell-integration 이 실패한 명령을 성공으로 표기하던 회귀.
  `$LASTEXITCODE` 폴백을 추가했다.
  구현: `src/main/pty/shell-hooks/pwsh.ps1`.
- **Multiview 자동 종료** — 77e4d58. 멀티뷰에 포함되지 않은 워크스페이스로
  전환할 때 멀티뷰가 그대로 유지되어 잘못된 팬이 화면에 남던 문제. 전환
  시점에 멀티뷰 상태를 자동 해제한다.
  구현: `src/renderer/store/uiSlice.ts`.
- **우클릭 이미지 붙여넣기** — d071b08 + 889c6d8. (1) 우클릭 컨텍스트
  메뉴에서 이미지 붙여넣기를 지원하고 (2) 공백이 포함된 임시 경로를
  올바르게 quoting + bracketed paste 로 래핑해 셸이 명령을 즉시 실행하지
  않도록 한다. 큰 텍스트 chunk 의 분할 전송 경로도 정리됐다.
  구현: `src/renderer/hooks/useTerminal.ts`,
  `src/main/clipboard/ImagePaste.ts`.
- **Ultrareview 6 건 일괄 수정** — b79115c. SoulLoader RCE/Windows
  비호환 경로(POSIX heredoc → IPC `fs.writeFile`), A2A CR/LF/ANSI 인젝션
  (`safeName`/`safeBody` 가 ESC CSI 와 개행을 strip), StateWriter
  saveImmediate race(immediateEpoch 스냅샷 보존), Squirrel 설치 파일명
  pin (`wmux-{version}.Setup.exe`) 등.
  구현: `src/company/core/SoulLoader.ts`,
  `src/main/a2a/envelope.ts`, `src/daemon/StateWriter.ts`,
  `forge.config.ts`.
- **SoulLoader fs 가드** — `window.electronAPI.fs` 가 옵셔널인데 가드
  없이 접근하던 부분으로 strict TS 체크가 깨져 CI 가 레드였던 문제.
  fs 가 없으면 false 를 반환하도록 정리.
  구현: `src/company/core/SoulLoader.ts`.

### Changed

- **MCP 워크스페이스 claim** — 9db0b25. 외부 MCP 호출자가 사용자의 active
  pane 을 hijack 하지 않고 전용 워크스페이스를 점유한다 (`mcp.claimWorkspace`).
  다중 MCP 클라이언트가 한 wmux 인스턴스에 붙는 시나리오에서 키 입력
  충돌을 제거한다. 기존 클라이언트는 자동 폴백.
  구현: `src/mcp/server.ts`, `src/daemon/WorkspaceClaim.ts`.
- **PTY env filter 일원화** — b19f25a. spawn 직전 env 화이트리스트가
  여러 곳에 흩어져 있던 것을 한 모듈로 모으고, browser export 경로도
  같은 sanitizer 를 거치도록 정리해 환경변수 누설 surface 를 줄였다.
  구현: `src/main/pty/envFilter.ts`,
  `src/main/browser/exportPaths.ts`.

### Internal

- 릴리스 워크플로우에 winget publishing step 추가 (#5, 825f4ee).
- README/SEO 정리 — `cmux for Windows` 포지셔닝 강화, 설치 가이드에
  winget·choco 명령 추가 (0fbbe43, 5f89c0e).

### Migration Notes

스키마 변경 없음. 자동 마이그레이션도 필요 없다. MCP 통합을 사용하는
외부 클라이언트만 워크스페이스 점유 동작 변화를 확인할 것.

## [2.7.1] — 2026-04-20 — Constrained Language Mode Hotfix

PowerShell Constrained Language Mode (AppLocker / WDAC가 적용된 회사·학교 PC)
환경에서 v2.7.0 사용 시 `사용자 지정 키 처리기에서 예외가 발생했습니다`
오류가 매 Enter / 매 prompt 렌더마다 발생하던 회귀를 수정한다. 다른
변경 사항은 없으며 데이터 마이그레이션도 필요 없다.

### Fixed

- **Shell integration script (OSC 133)** — `Set-PSReadLineKeyHandler`의
  Enter 핸들러가 `[Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()` /
  `[Console]::Write()`를 호출하던 부분이 Constrained Mode에서 메서드 호출
  금지 정책에 걸려 PSReadLine이 매 키스트로크마다 예외를 노출했다. 이제
  init 스크립트가 시작 시 `$ExecutionContext.SessionState.LanguageMode`를
  검사해 `FullLanguage`가 아니면 통합 자체를 건너뛰고, 핸들러 본문도
  try/catch로 감싸 런타임 실패 시 plain `AcceptLine`으로 폴백한다.
  구현: `src/daemon/shell-integration.ts`, `INTEGRATION_VERSION` 1 → 2로
  bump하여 디스크에 캐시된 옛 스크립트가 자동으로 재생성된다.
- **PWSH prompt hook (OSC 7 / 7727)** — `[System.Net.Dns]::GetHostName()`
  과 `[Console]::Write()`가 Constrained Mode에서 매 prompt 렌더 시 예외를
  던지던 문제. 이제 LanguageMode 게이트 + try/catch + `$env:COMPUTERNAME`
  치환으로 안전하다.
  구현: `src/main/pty/shell-hooks/pwsh.ps1`.
- **Terminal 우클릭 UX** — 항상 Copy/Paste 모달이 뜨던 동작을 Windows
  Terminal 스타일로 정리. 선택 영역이 있으면 즉시 복사 + 선택 해제, 없으면
  즉시 붙여넣기, 링크 위에서만 작은 컨텍스트 메뉴(Open Link / Copy Link)가
  뜬다. 모달 인터럽트 제거.
  구현: `src/renderer/hooks/useTerminal.ts`,
  `src/renderer/components/Terminal/ContextMenu.tsx`.
- **타입 부채 정리** — `companySlice`에 `taskHistory` / `waitGraph` /
  `createCompany`의 `workDir` 누락, `IPC.FS_WRITE_FILE` 상수 미정의,
  `OnboardingOverlay`의 옛 필드명 참조 등 27건의 TypeScript 오류를 해결해
  PR CI가 다시 녹색이 된다. 런타임 동작 변화는 없다.

## [2.7.0] — 2026-04-19 — Terminal UX Expansion

Terminal 사용성에 집중한 피처 릴리스다. 데몬/세션 영속성 계층 변경은 없으며,
업그레이드 시 추가 조치는 필요 없다. 키 바인딩 기본값이 추가·변경되었으므로 기존
커스텀 바인딩과 충돌이 없는지 한 번 확인해 두면 좋다.

### Added

- **Floating pane (Quake 스타일 드롭다운 터미널)** — 전역 핫키로 메인 레이아웃과
  독립된 터미널 팬을 띄우거나 숨긴다. 첫 호출 시 전용 PTY를 생성해 세션 유지.
  구현: `src/renderer/components/Terminal/FloatingPane.tsx`, `uiSlice`의
  `floatingPaneVisible`/`floatingPanePtyId`.
- **우클릭 컨텍스트 메뉴** — 복사·붙여넣기·링크 열기·링크 복사 항목. 선택 영역 및
  커서 아래 링크 감지에 따라 메뉴 항목이 동적으로 변경된다. ESC·바깥 클릭으로 닫힘,
  뷰포트 밖으로 넘어가지 않도록 위치 클램핑.
  구현: `src/renderer/components/Terminal/ContextMenu.tsx`.
- **스크롤 북마크** — 현재 스크롤 위치를 북마크로 찍고 이후 해당 라인으로 즉시
  점프한다. 컨테이너 좌측에 북마크 인디케이터가 뜨며, 스크롤에 따라 뷰포트 내에
  들어온 북마크만 렌더링된다.
  구현: `BookmarkIndicator.tsx`, `paneSlice`의 `bookmarks` 필드.
- **tmux 스타일 prefix 모드** — `Ctrl + <prefix key>` 입력 후 다음 단일 키로 동작을
  발동. 분할(가로/세로), 팬 닫기, 워크스페이스 순회, 포커스 이동, 팔레트 호출,
  플로팅 팬 토글 등 13종의 액션을 제공하며 사용자 바인딩 커스터마이즈 및 기본값
  초기화 지원.
  구현: `useKeyboard.ts`, `SettingsPanel` prefix 섹션, `uiSlice` prefix 상태.
- **레이아웃 템플릿** — 현재 분할 레이아웃을 저장해 재사용. 명령 팔레트에서 "레이아웃:"
  항목으로 빠르게 적용하고 "최근" 카테고리에서 직전 사용 항목을 바로 호출.
  구현: `CommandPalette`, `workspaceSlice` / `paneSlice`.
- **정규식 검색 토글** — 터미널 검색 바에서 regex 모드를 on/off 할 수 있다. xterm
  `SearchAddon`의 regex 옵션 전달.
- **xterm Unicode 11 width tables** — `@xterm/addon-unicode11` 추가 후
  `terminal.unicode.activeVersion = '11'` 활성화. CJK/이모지 width 산정을 v11 기준으로
  맞춰 TUI 앱(특히 Claude Code)의 cursor positioning과 한글 glyph 폭이 일치한다.

### Changed

- `useTerminal` hook — scrollback 복원·컨텍스트 메뉴 이벤트·right-click paste
  fallback 경로가 정리되었고, WebGL 컨텍스트 수명관리(가시성 기반 dispose/reload)
  로직이 명확해졌다.
- Preload 계층 — `window.electronAPI.shell.openExternal` / 클립보드 IPC 노출 경로가
  컨텍스트 메뉴와 링크 오픈 플로우에 맞춰 소폭 확장되었다.
- i18n 4개 언어(한국어·영어·일본어·중국어)에 prefix 모드, 컨텍스트 메뉴, 플로팅 팬,
  검색 regex, 레이아웃 저장, 북마크 문자열 40여 키 추가.

### Fixed

- **한글·CJK 프레임 겹침 (Claude Code TUI 렌더링 깨짐)** — xterm 기본 Unicode v6이
  한글의 display width를 잘못 계산해 ANSI CUP(cursor position) 시퀀스를 쓰는 TUI
  애플리케이션의 프레임이 겹쳐 그려지던 문제. Unicode 11 활성화로 해결.
  (재현: Claude Code 실행 중 한글 입력 후 thinking 애니메이션이 돌아갈 때 상태바가
  프롬프트 위에 겹쳐 쓰이는 증상.)

### Migration Notes

스키마 변경은 없다. 기존 데이터·세션·워크스페이스는 그대로 로드된다. 기본 prefix
키는 비활성 상태로 출발하므로 사용자가 활성화하기 전까지는 기존 단축키 동작에 영향이
없다.

## [2.6.0] — 2026-04-17 — Stability & Persistence Hardening

이번 릴리스는 daemon 안정성과 세션 영속성을 강화하는 방어·복원 작업이다.
사용자 데이터 파일 포맷 자체는 동일하되, 저장 경로와 에러 처리에 내부 변화가 있다.
업그레이드 시 추가로 할 일은 없다. 자동 마이그레이션으로 처리된다.

### Added

- `src/daemon/util/atomicWrite/` — 공통 atomic-write 모듈. tmp→bak→rename 순서와
  `__proto__`/`constructor`/`prototype` sanitizer를 한 곳에서 관리한다. SessionManager와
  StateWriter의 중복 구현이 이 모듈로 통합된다.
- `src/daemon/util/AsyncQueue.ts` — 30~50줄 수준의 자체 Promise 큐. `saveDebounced`
  경로에서 concurrent write 경합을 제거한다. `flushSync()` 메서드로 종료 시점의
  synchronous drain을 보장한다.
- `src/main/ipc/wrapHandler.ts` — `ipcMain.handle` 전용 래퍼. 핸들러 예외를
  구조화 JSON 로그(`{ts, level, event, channel, error_code, stack}`)로 메인 프로세스
  stderr에 기록하고, 에러에 `code` 속성을 부여한다.
- `.bak` rotation chain — save 성공 시 `.bak.2→.bak.3`, `.bak.1→.bak.2`, `.bak→.bak.1`
  rename 체인이 실행되어 최근 3개 스냅샷이 유지된다. 읽기 경로는
  primary → .bak → .bak.1 → .bak.2 → .bak.3 순서로 fallback한다.
- Lazy 마이그레이션 프레임워크 — `src/daemon/migrations/`. load 시점에 스키마 버전을
  확인하고 메모리에서만 체이닝 변환한다. 새 포맷 기록은 다음 save에서 이루어진다.
  프로덕션 레지스트리는 `CURRENT_VERSION=1`로 identity 유지 상태다.
- 손상 파일 격리 — validate 실패 시 파일을 `{userData}/corrupted/` 서브디렉토리로
  이동하고 `CORRUPT_FILE` 이벤트를 JSON 로그로 남긴다. 30일 경과 또는 10개 초과 시
  오래된 격리 파일이 자동 정리된다.
- Premigrate 스냅샷 — 스키마 업그레이드가 발생하는 load 경로에서 원본을
  `{basename}.v{N}.premigrate.bak`로 일회성 보존한다. 롤백 자료로 사용된다.

### Changed

- IPC 에러 포맷이 통일된다. 이전에는 핸들러 예외가 renderer로 그대로 promise
  rejection 되어 stack이 불분명했다. 이번 릴리스부터 메인 프로세스 stderr에 JSON
  line으로 기록되고, 에러 객체에 `code` 속성이 붙는다. 사용 가능한 코드는
  `DAEMON_DISCONNECTED`, `VALIDATION_ERROR`, `NOT_FOUND`, `PERMISSION_DENIED`,
  `UNKNOWN`이다. renderer 호출부의 응답 값 자체는 그대로 raw value를 반환한다
  (정규화는 후속 작업인 T4 `useIpc` 훅에서 수용 예정).
- `StateWriter`와 `SessionManager`의 내부 구조 — atomic-write 중복 경로를 공통
  모듈 호출로 치환했다. 외부 API 시그니처는 변경 없다. `saveImmediate`는 기존 동기
  시그니처를 유지한다(shutdown/suspend emergency sync 경로 호환).
- Rotation allowlist regex가 `^sessions\.json\.bak(\.[123])?$` 패턴에 한정된다.
  `corrupted/` 디렉토리와 `*.premigrate.bak` 파일은 rotation 대상에서 제외된다.

### Fixed

- StateWriter/SessionManager의 concurrent save race — AsyncQueue coalescing
  (같은 key 재진입 시 마지막 값만 실행, key 간은 FIFO 보장)로 해결.
- IPC 핸들러에서 던진 예외가 메인 로그에 남지 않는 문제 — `wrapHandler`가 전 핸들러
  공통 try/catch 경로로 흡수하고 stderr JSON 로그로 기록한다.
- validate 실패 시 무음으로 빈 세션이 출발하던 문제 — 손상 파일을 corrupted/로
  격리하고, .bak 체인에서 fallback을 시도한다. 복구에 성공하면 즉시 승격 save.

### Migration Notes

사용자 데이터 손실은 발생하지 않는다. 업그레이드 절차에서 수동 작업은 없다.
다만 `{userData}` 디렉토리 내부에 다음 두 종류의 새 경로가 등장한다.

- `{userData}/corrupted/` — validate 실패로 격리된 파일의 보관소. 30일 경과 또는
  10개 초과 시 자동 정리된다.
- `{basename}.premigrate.bak` — 스키마 업그레이드 load 시점에 생성되는 원본
  스냅샷. 자동 정리 대상이 아니다. 수동 삭제 가능(향후 릴리스에서 자동 정리 검토).

플랫폼별 `{userData}` 경로와 롤백 절차는
[`docs/upgrade-2026-04-17.md`](docs/upgrade-2026-04-17.md)를 참고한다.
