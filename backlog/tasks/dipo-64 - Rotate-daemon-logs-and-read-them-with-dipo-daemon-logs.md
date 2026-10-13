---
id: DIPO-64
title: Rotate daemon logs and read them with dipo daemon logs
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-13 08:04'
labels:
  - 'tier:S'
  - after-cutover
milestone: m-0
dependencies:
  - DIPO-23
references:
  - packages/engine/src/log/
  - packages/cli/src/
  - packages/engine/test/log/
  - packages/client/src/node/logs/
  - packages/client/src/node/index.ts
  - packages/client/test/
documentation:
  - docs/decisions/0006-daemon-and-ipc.md
priority: medium
type: feature
ordinal: 64000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the daemon rotates `daemon.log` at 10 MB keeping five files, and `dipo daemon logs [-f] [--office] [--run] [--level]` renders and filters the JSON lines without needing a running daemon.

Context: the log reader lives in `client/node`, because `cli` never imports `engine` and the command must work with the daemon stopped (named offline maintenance, 0006 amendment of 2026-10-12); rotation stays in the daemon's log module (M0 review, DIPO-15). References: 0006 decision 13 (rotation, levels, privacy, the logs command), decision 5 (logs read directly from files).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

Built after cutover: dipo delivers this story itself (M0 review decision D14, DIPO-15).

```dipo
branch: "DIPO-64/rotate-daemon-logs-read-them-dipo-daemon"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) rotation at the size limit; filters over a fixture log."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 At 10 MB `daemon.log` becomes `daemon.log.1` and older files shift up to `.5`.
- [x] #2 `dipo daemon logs` reads the files directly through a log reader in `client/node`, imports nothing from `engine`, and works with the daemon stopped.
- [x] #3 `-f` follows across a rotation; `--office`, `--run` and `--level` filter lines.
- [x] #4 Prompts, worker output and command bodies appear only at `debug` and `trace`.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S48 (DIPO-15). After cutover: built by dipo itself, not by a hand-run agent.

Implementation (DIPO-64):
- Rotation: packages/engine/src/log/file.ts. openLogFile rotates before a line would take daemon.log past 10 MB (DAEMON_LOG_MAX_BYTES), shifting daemon.log.1..4 up and dropping .5 (DAEMON_LOG_KEEP). A single line longer than the limit gets a file of its own.
- Privacy: packages/engine/src/log/logger.ts. Fields named in DEBUG_ONLY_KEYS (prompt, output, stdout, stderr, body, args) are replaced by "[debug only]" at any depth in error, warn and info lines; debug and trace lines keep them. Code that logs prompts, worker output or command bodies must use one of these names.
- Reader: packages/client/src/node/logs/reader.ts (readLogs, LogFollower, followLogs, filters, rendering). The file names are repeated from engine because client may not import engine; test/daemon-logs proves both agree.
- Command: packages/cli/src/logs-command.ts. -f prints the rotated files and daemon.log, then polls every 250 ms through the injected Clock and follows rotations by inode. --level keeps that level and more severe ones. Non-JSON lines are shown only without filters.

Scope additions:
- test/daemon-logs/daemon-logs.test.ts (root test, outside References): runs the engine writer against the client reader, like test/state-dir does for the state anchor.
<!-- SECTION:NOTES:END -->
