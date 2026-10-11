---
id: DIPO-25
title: Reach the daemon from the CLI through the client package
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-11 18:49'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-24
references:
  - packages/client/
  - packages/cli/src/
documentation:
  - docs/decisions/0004-language-and-runtime.md
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0006-daemon-and-ipc.md
  - docs/decisions/0009-tui.md
priority: high
type: feature
ordinal: 25000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `packages/client` gives every UI a typed connection with reconnect and request ids, and a lifecycle module that starts, stops, restarts and reports the daemon, used by `dipo daemon start|stop|restart|status|log-level|resume-scheduling` and by client autostart.

Context: `cli` never imports `engine`; everything here goes through `client`. References: 0006 decisions 2 (client subcommands, `lifecycle` module), 5 (start, stop, `--force`, status outputs and exit codes), 14 (restart across versions); 0005 section 9 (retry with the same `requestId`); 0009 section 7 (backoff 0.5 s doubling to 5 s); 0004 boundary rules.

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

```dipo
branch: "DIPO-25/reach-daemon-from-cli-through-client"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(integration) client against a daemon in a temp `DIPO_HOME`: hello, command, disconnect, reconnect and replay without duplicates."
    - kind: "automated"
      check: "(integration, CI only) `start`, `status`, `stop`, `restart` on a compiled binary."
    - kind: "manual"
      check: "`dipo daemon status` with no daemon"
      expect: "prints `not running`, exit code 3; `dipo daemon start` then `status` -> prints `running` with PID and version."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `Client` connects with `ws+unix://` to the socket named in `<state>/runtime.json`, sends `engine.hello`, matches replies by `requestId`, and exposes typed `command`, `read` and `subscribe` methods built from contract schemas.
- [ ] #2 On disconnect it reconnects with backoff from 0.5 s doubling to 5 s, re-subscribes after the last cursor, and re-sends an unanswered command with the same `requestId`.
- [ ] #3 `lifecycle.start` spawns `dipo daemon --foreground` detached with stdio ignored and `BUN_OPTIONS` removed, waits up to 5 s for `engine.hello`, and prints PID and version.
- [ ] #4 Any client command that needs the daemon starts it the same way unless `daemon.autostart = false`.
- [ ] #5 `dipo daemon status` prints `running`, `not running`, `unresponsive` or `stale` with exit codes 0, 3, 1 as 0006 decision 5, and `--json` prints the same as JSON.
- [ ] #6 `dipo daemon stop` sends `daemon.stop`; `--force` sends SIGTERM to the PID from `dipo.pid` after verifying PID and start time, then SIGKILL after 10 s.
- [ ] #7 `dipo daemon restart` uses `daemon.stop` for the same contract major and verified-PID SIGTERM for a different one, waits for the PID to exit, then starts the new daemon.
- [ ] #8 A client whose binary version differs from the daemon's prints the restart hint of 0006 decision 14.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S10 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
