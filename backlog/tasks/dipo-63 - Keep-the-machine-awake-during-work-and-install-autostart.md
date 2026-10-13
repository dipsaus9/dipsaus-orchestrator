---
id: DIPO-63
title: Keep the machine awake during work and install autostart
status: Done
assignee:
  - '@claude'
created_date: '2026-10-11 18:48'
updated_date: '2026-10-13 13:01'
labels:
  - 'tier:M'
  - after-cutover
milestone: m-0
dependencies:
  - DIPO-44
  - DIPO-70
references:
  - packages/engine/src/platform/keepawake.ts
  - packages/engine/src/keepawake/
  - packages/cli/src/
  - packages/engine/test/keepawake/
  - packages/client/src/node/lifecycle/
  - packages/engine/src/host/
  - packages/contract/
  - packages/daemon/src/
  - packages/client/src/node/index.ts
  - packages/engine/src/index.ts
documentation:
  - docs/decisions/0004-language-and-runtime.md
  - docs/decisions/0006-daemon-and-ipc.md
priority: medium
type: feature
ordinal: 63000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the daemon holds one idle-sleep assertion while work is active and releases it two minutes after, and `dipo daemon install|uninstall` sets up a launchd agent or systemd user unit that restarts the daemon after a crash.

Context: `install`, `uninstall` and the supervisor paths live in the `lifecycle` module of `client/node` (DIPO-70; 0004 and 0006 amendments of 2026-10-12); `install` is named offline maintenance outside the contract. The unit carries the user's `PATH` so the daemon resolves the same tools as the shell (M0 review, DIPO-15). The keep-awake reason joins `daemon.status` in the contract. This story implements the `wait-pid` `runDaemon` form that DIPO-23 dispatches, and the keep-awake holder in the daemon. References: 0006 decision 12 (`caffeinate -i -w`, `systemd-inhibit` with `wait-pid`, polkit fallback to `delay`, status reason), decision 15 (plist and unit keys, lingering warning, start and stop through the supervisor), decision 8 (systemd scopes for worker hosts).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

Built after cutover: dipo delivers this story itself (M0 review decision D14, DIPO-15).

```dipo
branch: "DIPO-63/keep-machine-awake-during-work-install"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) generated plist and unit files (golden), each carrying the caller's `PATH`; the `launchctl` domain is `user/<uid>` when `gui/<uid>` is missing."
    - kind: "automated"
      check: "(engine) assertion requested on run start and released 2 minutes after run end on the manual clock."
    - kind: "manual"
      check: "`dipo daemon install` on macOS, then `kill -9` the daemon"
      expect: "launchd restarts it within a few seconds; `pmset -g assertions` shows `caffeinate` only during a run."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Work is active while a run has a live host, a verify is running, or a confirmed batch waits to start (a `work.run` that has claimed a story whose worker has not started); the assertion is released 2 minutes after the last.
- [x] #2 macOS spawns `caffeinate -i -w <daemon-pid>`; Linux spawns `systemd-inhibit --what=idle:sleep --mode=block ... dipo daemon wait-pid <pid>`, retries once with `--mode=delay`, and `daemon.status` reports "keep-awake not held: <reason>" when neither holds.
- [x] #3 `install` writes the plist with `KeepAlive.SuccessfulExit = false`, `AbandonProcessGroup = true`, `ExitTimeOut = 75`, or the unit with `Restart=on-failure`, `TimeoutStopSec=75`, using the binary's absolute path and the installing user's `PATH` (`EnvironmentVariables.PATH` in the plist, `Environment=PATH=` in the unit).
- [x] #4 On Linux, `install` and `status` warn when lingering is off and explain `loginctl enable-linger` without running it.
- [x] #5 Under systemd, worker hosts start in their own `systemd-run --user --scope` unit.
- [x] #6 When installed, `dipo daemon start|stop|restart` go through `launchctl` or `systemctl --user`; over SSH, where the `gui/<uid>` launchd domain is missing, `launchctl` uses `user/<uid>`.
- [x] #7 A daemon that refuses its `config.yaml` (exit 78, `EXIT_CONFIG` from packages/contract, DIPO-69) is not restarted in a loop: the systemd unit sets `RestartPreventExitStatus=78`, and under launchd the daemon runs `launchctl bootout` on its own job before exiting (launchd may then end it with SIGTERM instead of 78; the plist keeps `KeepAlive.SuccessfulExit = false`, 0006 decision 15). `dipo daemon status` learns of the refusal on the client side through `readSoftwareConfig`. Tests cover the generated unit file and the bootout path.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S47 (DIPO-15). After cutover: built by dipo itself, not by a hand-run agent.

Scope additions (files outside References):
- packages/engine/src/platform/supervisor.ts: the platform seam for the daemon's supervisor: detecting the dipo.service cgroup and wrapping worker hosts in systemd-run --user --scope (AC #5), and the launchctl bootout of its own job after a refused config.yaml (AC #7). Kept apart from platform/keepawake.ts because it is not keep-awake.
- packages/engine/src/runs/worker-hosts.ts: launchWorkerHost starts the host inside its own systemd scope when the daemon runs under dipo.service (AC #5); option systemdScope, default detected.
- packages/client/test/unit/supervisor.test.ts and packages/client/test/unit/fixtures/supervisor/{dipo.daemon.plist,dipo.service}: tests and golden files for the plist, the unit and the supervisor-routed lifecycle (AC #3, #4, #6, #7).

Notes:
- No contract change: daemon.status.keepAwake { held, reason? } already exists (0005). The CLI now prints 'keep-awake: not held: <reason>' and 'held (<reason>)'.
- Running verifies register through WorkTracker.beginVerify(); no verify step exists yet, so only the test calls it. Live hosts and waiting claims are read from worker_hosts and claims in the state database.

Review follow-ups (PR #79):
- Scope addition: packages/engine/src/platform/process.ts: detachedEnv strips XPC_SERVICE_NAME (with client daemonEnv), so a child never looks like the installed launchd job.
- The launchd bootout after exit 78 now also requires launchd as the parent (ppid 1) and launchctl print reporting this PID as the job's; an inherited XPC_SERVICE_NAME alone boots nothing out.
- A live claim without a worker host counts as waiting to start only within CLAIM_START_WINDOW_MS (5 minutes) of its claim. DIPO-56 (reconcile at daemon start) must release orphan claims (a run that died between claim and host start).
- DIPO-49 (verify) must wire WorkTracker.beginVerify() around each verify step, so a running verify keeps the machine awake.
- LAUNCHD_LABEL and SYSTEMD_UNIT moved into packages/contract (additive, no version bump); the client uses EXIT_CONFIG from the contract.
- Follow-up, not changed here: with daemon.autoRestartOnUpgrade under launchd or systemd, the daemon still starts the new binary itself, outside the supervisor (0006 decision 14). A later story should restart through the supervisor instead.

Maintainer manual test passed on macOS (2026-10-13): install, crash restart by launchd, keep-awake held and released 2 min after work, stop/start/restart via launchctl, uninstall. Follow-up wording: daemon status shows 'running (recovered)' after every start, also a clean one.
<!-- SECTION:NOTES:END -->
