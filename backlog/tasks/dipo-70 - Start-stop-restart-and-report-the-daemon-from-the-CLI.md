---
id: DIPO-70
title: 'Start, stop, restart and report the daemon from the CLI'
status: To Do
assignee: []
created_date: '2026-10-12 09:21'
updated_date: '2026-10-12 14:34'
labels:
  - 'tier:M'
  - test-before-merge
milestone: m-0
dependencies:
  - DIPO-25
  - DIPO-68
  - DIPO-69
references:
  - packages/client/src/node/lifecycle/
  - packages/client/test/
  - packages/cli/src/
  - packages/daemon/src/
  - packages/engine/src/platform/tools.ts
  - packages/engine/test/platform/
  - packages/engine/src/index.ts
  - packages/client/src/node/index.ts
documentation:
  - docs/decisions/0004-language-and-runtime.md
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0006-daemon-and-ipc.md
priority: high
type: feature
ordinal: 25700
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the `lifecycle` module in `client/node` starts, stops, restarts and reports the daemon for `dipo daemon start|stop|restart|status` and for client autostart, keeps the user's `PATH` for the daemon, and shows the absolute tool paths the daemon resolved at start.

Context: split from DIPO-25 in the M0 review (DIPO-15); DIPO-25 keeps the protocol core and the transport. Autostart reads `daemon.autostart` from `<state>/config.yaml` (DIPO-69). The daemon resolves absolute paths of `claude`, `backlog`, `gh`, `rg` and `git` at start, so a launchd, systemd or SSH start uses the same tools as the maintainer's shell, and reports them in the `daemon.status` field defined in DIPO-19. The PID and start-time identity check is DIPO-23's. References: 0006 decisions 2 (client subcommands, `lifecycle` module), 5 (start, stop, `--force`, status outputs and exit codes), 14 (restart across versions, `upgrade pending`, `daemon.autoRestartOnUpgrade`) and the 2026-10-12 amendments (`client/node`, `<state>/config.yaml`); 0005 section 11 (frozen minimal surface); 0004 boundary rules and the 2026-10-12 amendment.

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-70/start-stop-restart-report-daemon-from"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(integration, CI only) `start`, `status`, `stop`, `restart` on a compiled binary in a temp `DIPO_HOME`."
    - kind: "automated"
      check: "(unit) with `daemon.autostart: false` a client command that needs the daemon fails with a message naming `dipo daemon start` and spawns nothing."
    - kind: "automated"
      check: "(unit) tool path resolution over a fake `PATH`; a missing `rg` is reported as missing."
    - kind: "automated"
      check: "(engine) on the manual clock a changed executable gives `upgrade pending`; with `daemon.autoRestartOnUpgrade: true` the daemon drains once no engine step runs."
    - kind: "manual"
      check: "`dipo daemon status` with no daemon"
      expect: "prints `not running`, exit code 3; `dipo daemon start` then `status` -> prints `running` with PID, version and the absolute paths of `claude`, `backlog`, `gh`, `rg` and `git`."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `lifecycle.start` spawns `dipo daemon --foreground` detached with stdio ignored, `BUN_OPTIONS` removed and the caller's `PATH` kept, waits up to 5 s for `engine.hello`, and prints PID and version.
- [ ] #2 Any client command that needs the daemon starts it the same way unless `daemon.autostart` is `false` in `<state>/config.yaml`.
- [ ] #3 At start the daemon resolves the absolute paths of `claude`, `backlog`, `gh`, `rg` and `git` from its `PATH`, logs them, and returns them in `daemon.status`; a missing tool is reported as missing and does not stop the start.
- [ ] #4 `dipo daemon status` prints `running` (state, reason, PID, version, uptime, socket, tool paths), `not running`, `unresponsive` or `stale` with exit codes 0, 3, 1 as 0006 decision 5, and `--json` prints the same as JSON.
- [ ] #5 `dipo daemon stop` sends `daemon.stop`; `--force` sends SIGTERM to the PID from `dipo.pid` after the DIPO-23 identity check of PID and start time, then SIGKILL after 10 s.
- [ ] #6 `dipo daemon restart` uses `daemon.stop` for the same contract major and verified-PID SIGTERM for a different one, waits for the PID to exit, then starts the new daemon.
- [ ] #7 A client whose binary version differs from the daemon's prints the restart hint of 0006 decision 14.
- [ ] #8 The daemon checks its executable every 60 s and reports `upgrade pending` in `daemon.status` when it changed; with `daemon.autoRestartOnUpgrade: true` it drains and starts the new binary once no engine step (setup, install, verify, commit) is running.
- [ ] #9 `lifecycle` treats a leftover `<state>/runtime.json` as stale when `dipo.pid` is missing or fails the DIPO-23 PID and start-time check, and `dipo daemon status` reports `not running` (or `stale` once leftovers are cleaned) with exit 3; a test covers it.
- [ ] #10 Before an autostart, the client reads `<state>/config.yaml` with `readSoftwareConfig` (DIPO-69) and shows its errors instead of starting a daemon that exits 78; a test covers it.
- [ ] #11 The client starts the daemon with both `BUN_OPTIONS` and `BUN_FEATURE_FLAG_NO_ORPHANS` removed from its environment (DIPO-44 finding); a test covers it.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Split from DIPO-25 in the M0 review (DIPO-15); carries DIPO-25's test-before-merge flag for the daemon lifecycle behaviour. Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
