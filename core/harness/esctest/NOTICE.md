# NOTICE — esctest2 execution-time dependency (E0 conformance harness, M3)

The E0 conformance harness can optionally exercise the terminal core against
**esctest2** (https://github.com/ThomasDickey/esctest2), a VT conformance test
suite authored by George Nachman and Thomas E. Dickey.

- **License**: esctest2 is licensed under the **GNU General Public License,
  Version 2 (GPL-2.0)**.
- **Isolation**: esctest2 source is **never committed to this repository** and
  **never included in any build artifact, CI cache, or distributed package**.
  It is cloned at run time (pinned commit) into
  `core/harness/esctest/vendor/`, which is gitignored. The wmux product build
  (`src/`, packaged app) has zero contact with esctest2 code.
- **What this repo contains**: only an *adapter* that drives the pinned esctest2
  process over a PTY and routes query/response bytes to the subject under test.
  The adapter and the DECRQCRA checksum bridge are original work derived from
  the DEC STD 070 and xterm `ctlseqs` specifications — **not** ported from the
  GPL-licensed esctest2 checksum logic (clean-room discipline, see
  `plans/engine-core-decision-2026-07-09.md` §5-3).

This notice documents the execution-time relationship only. Because no esctest2
code is redistributed, this file is not part of any distributed NOTICE bundle.
