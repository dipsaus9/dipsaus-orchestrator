---
id: DIPO-64
title: Rotate daemon logs and read them with dipo daemon logs
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 09:52'
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
- [ ] #1 At 10 MB `daemon.log` becomes `daemon.log.1` and older files shift up to `.5`.
- [ ] #2 `dipo daemon logs` reads the files directly through a log reader in `client/node`, imports nothing from `engine`, and works with the daemon stopped.
- [ ] #3 `-f` follows across a rotation; `--office`, `--run` and `--level` filter lines.
- [ ] #4 Prompts, worker output and command bodies appear only at `debug` and `trace`.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S48 (DIPO-15). After cutover: built by dipo itself, not by a hand-run agent.
<!-- SECTION:NOTES:END -->
