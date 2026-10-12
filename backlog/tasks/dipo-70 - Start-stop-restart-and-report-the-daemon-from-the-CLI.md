---
id: DIPO-70
title: 'Start, stop, restart and report the daemon from the CLI'
status: Done
assignee: []
created_date: '2026-10-12 09:21'
updated_date: '2026-10-12 20:32'
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
  - packages/daemon/test/
  - test/lifecycle-parity/
  - packages/client/src/node/connect.ts
  - packages/client/src/node/runtime.ts
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
- [x] #1 `lifecycle.start` spawns `dipo daemon --foreground` detached with stdio ignored, `BUN_OPTIONS` removed and the caller's `PATH` kept, waits up to 5 s for `engine.hello`, and prints PID and version.
- [x] #2 Any client command that needs the daemon starts it the same way unless `daemon.autostart` is `false` in `<state>/config.yaml`.
- [x] #3 At start the daemon resolves the absolute paths of `claude`, `backlog`, `gh`, `rg` and `git` from its `PATH`, logs them, and returns them in `daemon.status`; a missing tool is reported as missing and does not stop the start.
- [x] #4 `dipo daemon status` prints `running` (state, reason, PID, version, uptime, socket, tool paths), `not running`, `unresponsive` or `stale` with exit codes 0, 3, 1 as 0006 decision 5, and `--json` prints the same as JSON.
- [x] #5 `dipo daemon stop` sends `daemon.stop`; `--force` sends SIGTERM to the PID from `dipo.pid` after the DIPO-23 identity check of PID and start time, then SIGKILL after 10 s.
- [x] #6 `dipo daemon restart` uses `daemon.stop` for the same contract major and verified-PID SIGTERM for a different one, waits for the PID to exit, then starts the new daemon.
- [x] #7 A client whose binary version differs from the daemon's prints the restart hint of 0006 decision 14.
- [x] #8 The daemon checks its executable every 60 s and reports `upgrade pending` in `daemon.status` when it changed; with `daemon.autoRestartOnUpgrade: true` it drains and starts the new binary once no engine step (setup, install, verify, commit) is running.
- [x] #9 `lifecycle` treats a leftover `<state>/runtime.json` as stale when `dipo.pid` is missing or fails the DIPO-23 PID and start-time check, and `dipo daemon status` reports `not running` (or `stale` once leftovers are cleaned) with exit 3; a test covers it.
- [x] #10 Before an autostart, the client reads `<state>/config.yaml` with `readSoftwareConfig` (DIPO-69) and shows its errors instead of starting a daemon that exits 78; a test covers it.
- [x] #11 In addition to `BUN_OPTIONS` (#1), the client removes `BUN_FEATURE_FLAG_NO_ORPHANS` when it starts the daemon, like `BUN_FLAG_VARIABLES` for worker hosts (DIPO-44 finding); a test covers it.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Split from DIPO-25 in the M0 review (DIPO-15); carries DIPO-25's test-before-merge flag for the daemon lifecycle behaviour. Before cutover: built by hand-run agents.

Added references: `packages/daemon/test/` (the server harness gains `tools` and `upgradePending` for the new `daemon.status` fields; the upgrade watcher's manual-clock tests live in `packages/daemon/test/unit/upgrade.test.ts`, the "(engine)" test of the test plan) and `test/lifecycle-parity/` (`client` may not import `engine`, so `client/node` repeats the PID record parser, the process probe, the Bun flag variables and the logs directory; this root test runs both copies on the same inputs, like `test/state-dir`).

Implementation (DIPO-70):
- `client/node/lifecycle/`: `inspectDaemon` (running, foreign = other contract major, unresponsive, not running with the stale files it removed), `startDaemon`, `stopDaemon` (`daemon.stop`; `--force` = SIGTERM to the PID verified by PID, start time and `dipo daemon --foreground` command, SIGKILL after 10 s), `restartDaemon` (`daemon.stop` for the same major, verified SIGTERM for another, waits for the PID, then starts this binary; an invalid `config.yaml` refuses before anything stops), `connectOrStart` (autostart; reads `config.yaml` with `readSoftwareConfig` first) and `versionHint` (0006 decision 14 text).
- Stale files are removed by rename-and-verify (a newer file is put back with `link()`), and a `runtime.json` whose own PID and start time are alive is never removed. A graceful `stop` also removes the `runtime.json` the daemon leaves behind, so the next `status` says `not running`.
- The daemon is started through a short-lived `/bin/sh` (own session, stdio ignored) that backgrounds `dipo daemon --foreground` and exits, so the daemon is re-parented and is no descendant of the client. Reason: found in manual testing, a client that itself runs under `--no-orphans` (`BUN_FEATURE_FLAG_NO_ORPHANS=1` in its environment) SIGKILLs every descendant when it exits, so removing the variables from the daemon's environment (AC #11) was not enough. The daemon's environment is the caller's with `BUN_OPTIONS` and `BUN_FEATURE_FLAG_NO_ORPHANS` removed; `PATH` is kept.
- `engine/src/platform/tools.ts`: `resolveTools` (first executable on `PATH`, relative entries skipped) and the executable stamp (dev, inode, size, mtime). The daemon logs `tools resolved`, warns per missing tool and returns the paths in `daemon.status.tools`.
- `daemon/src/upgrade.ts`: `UpgradeWatcher` checks the executable every 60 s (`selfCommand()`'s last element: the compiled binary, or the entry script from source). With `daemon.autoRestartOnUpgrade: true` it requests the drain (reason `upgrade`) once the daemon has no child process and no in-flight command; after a clean drain, with the lock and socket released, the daemon starts the new binary detached with the same environment minus the Bun flag variables. Later stories that run engine steps (setup, install, verify, commit) must run them as daemon children (`ChildProcesses`) so the restart waits for them.
- CLI: `dipo daemon start|stop|restart|status [--json]`; `log-level` and `resume-scheduling` autostart and print the restart hint when versions differ. `START_HINT` no longer mentions `--foreground`.
- Tests: client lifecycle unit tests (stale files, autostart off and invalid config spawn nothing, env stripping, force stop, restart across majors), CLI output tests, tool resolution, upgrade watcher on the manual clock, parity test, and the CI-only `packages/client/test/integration/lifecycle.ci.test.ts` on the compiled binary.

Maintainer test steps (macOS, fresh temp state; the temp path must stay short so the runtime directory fits 100 bytes):
```
bun install && bun run build
export T=$(mktemp -d /tmp/dipo-test.XXXX)
export DIPO_HOME=$T/state DIPO_RUNTIME_DIR=$T/run DIPO_TMP=$T
./dist/dipo daemon status; echo "exit $?"       # not running / exit 3
./dist/dipo daemon start                         # dipo daemon started (pid N, version 0.0.0-dev)
./dist/dipo daemon status; echo "exit $?"       # running, state, pid N, version, uptime, socket $T/run/dipo.sock, tools with absolute paths (or "missing") / exit 0
./dist/dipo daemon status --json                 # {"status":"running","daemon":{...,"tools":{...}}}
./dist/dipo daemon restart                       # dipo daemon stopped (pid N) / dipo daemon started (pid M, ...)
./dist/dipo daemon stop                          # dipo daemon stopped (pid M)
./dist/dipo daemon status; echo "exit $?"       # not running / exit 3
echo '{"runtimeDir":"/nope","socket":"/nope/dipo.sock","pid":999999,"startTimeMs":1,"version":"x"}' > $T/state/runtime.json
./dist/dipo daemon status; echo "exit $?"       # stale / removed leftovers ...runtime.json / exit 3
./dist/dipo daemon status; echo "exit $?"       # not running / exit 3
printf 'version: 1\ndaemon:\n  autostart: false\n' > $T/state/config.yaml
./dist/dipo daemon log-level debug; echo "exit $?"   # ...daemon.autostart is false in .../config.yaml. Start it with `dipo daemon start`. / exit 1
printf 'version: 1\ndaemon:\n  autostart: maybe\n' > $T/state/config.yaml
./dist/dipo daemon log-level debug; echo "exit $?"   # cannot start the daemon: ...daemon.autostart: expected boolean, got string... / exit 1
./dist/dipo daemon status; echo "exit $?"       # not running / exit 3 (nothing was started)
rm $T/state/config.yaml
BUN_FEATURE_FLAG_NO_ORPHANS=1 BUN_OPTIONS=--no-orphans ./dist/dipo daemon log-level debug   # stderr: dipo: started the daemon (pid N, ...); stdout: daemon log level: debug (until the daemon restarts)
./dist/dipo daemon status | head -3              # running (the daemon survived the --no-orphans client)
bun packages/cli/src/main.ts daemon status >/dev/null   # stderr: dipo: daemon runs v0.0.0-dev, this binary is vdev, run `dipo daemon restart`
kill -STOP $(jq -r .pid $T/state/runtime.json)
./dist/dipo daemon status; echo "exit $?"       # after about 5 s: unresponsive ... run `dipo daemon stop --force` / exit 1
./dist/dipo daemon stop; echo "exit $?"         # does not answer. Run `dipo daemon stop --force` / exit 1
./dist/dipo daemon stop --force                  # after about 15 s: dipo daemon stopped (pid N, killed after 10 s)
./dist/dipo daemon status; echo "exit $?"       # not running / exit 3
mkdir $T/bin && cp dist/dipo $T/bin/dipo && $T/bin/dipo daemon start
cp dist/dipo $T/bin/dipo.new && mv $T/bin/dipo.new $T/bin/dipo && sleep 65
$T/bin/dipo daemon status | grep upgrade        # upgrade pending: the binary changed on disk; run `dipo daemon restart`
$T/bin/dipo daemon stop                          # dipo daemon stopped (pid ...)
pgrep -fl "daemon --foreground"; rm -rf $T       # pgrep prints nothing: no daemon left
```

Review fixes (PR #48): added references packages/client/src/node/connect.ts (connectToDaemon and DaemonNotRunningError moved out of client/node/index.ts so the lifecycle module can use them without an import cycle) and packages/client/src/node/runtime.ts (logsDir, so a failed start names <logs>/daemon.log). The daemon starts the new binary only when the drain's request was the upgrade, and the upgrade watcher counts as busy and stops once any stop is requested, so a daemon stopped by `dipo daemon stop`, SIGTERM, a restart or a lost lock never comes back on its own (test: packages/daemon/test/integration/upgrade-restart.test.ts). `stop --force` now removes the stale runtime.json also when SIGTERM ends the daemon within 10 s, so the next status says `not running`. An ADR 0006 amendment about starting the daemon through a short-lived /bin/sh (double fork, so a client running under --no-orphans cannot kill it on exit) will be proposed to the maintainer.

Maintainer test 2026-10-12: OK.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Daemon lifecycle from the CLI: client/node lifecycle module with dipo daemon start, stop [--force], restart and status [--json] (running, unresponsive, stale, not running; exit 0/1/3), autostart from log-level and resume-scheduling after reading config.yaml, start through a short-lived /bin/sh so a --no-orphans client cannot take the daemon down, Bun flag variables stripped, verified-identity signals for --force, stale leftovers removed safely, version mismatch hint; engine platform/tools.ts resolving claude/backlog/gh/rg/git for daemon.status.tools; daemon upgrade watcher (upgradePending, optional auto-restart only when idle and only for an upgrade drain). Reviewer pass; maintainer tested OK.
<!-- SECTION:FINAL_SUMMARY:END -->
