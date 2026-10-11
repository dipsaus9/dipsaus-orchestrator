---
id: DIPO-63
title: Keep the machine awake during work and install autostart
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-11 18:49'
labels:
  - 'tier:M'
  - after-cutover
milestone: m-0
dependencies:
  - DIPO-25
references:
  - packages/engine/src/platform/keepawake.ts
  - packages/engine/src/keepawake/
  - packages/client/src/lifecycle/
  - packages/cli/src/
  - packages/engine/test/keepawake/
documentation:
  - docs/decisions/0006-daemon-and-ipc.md
priority: medium
type: feature
ordinal: 63000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the daemon holds one idle-sleep assertion while work is active and releases it two minutes after, and `dipo daemon install|uninstall` sets up a launchd agent or systemd user unit that restarts the daemon after a crash.

References: 0006 decision 12 (`caffeinate -i -w`, `systemd-inhibit` with `wait-pid`, polkit fallback to `delay`, status reason), decision 15 (plist and unit keys, lingering warning, start and stop through the supervisor), decision 8 (systemd scopes for worker hosts).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

Built after cutover: dipo delivers this story itself (M0 breakdown decision D6, DIPO-15).

```dipo
branch: "DIPO-63/keep-machine-awake-during-work-install"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) generated plist and unit files (golden)."
    - kind: "automated"
      check: "(engine) assertion requested on run start and released 2 minutes after run end on the manual clock."
    - kind: "manual"
      check: "`dipo daemon install` on macOS, then `kill -9` the daemon"
      expect: "launchd restarts it within a few seconds; `pmset -g assertions` shows `caffeinate` only during a run."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Work is active while a run has a live host or a running verify; the assertion is released 2 minutes after the last.
- [ ] #2 macOS spawns `caffeinate -i -w <daemon-pid>`; Linux spawns `systemd-inhibit --what=idle:sleep --mode=block ... dipo daemon wait-pid <pid>`, retries once with `--mode=delay`, and `daemon.status` reports "keep-awake not held: <reason>" when neither holds.
- [ ] #3 `install` writes the plist with `KeepAlive.SuccessfulExit = false`, `AbandonProcessGroup = true`, `ExitTimeOut = 75`, or the unit with `Restart=on-failure`, `TimeoutStopSec=75`, using the binary's absolute path.
- [ ] #4 On Linux, `install` and `status` warn when lingering is off and explain `loginctl enable-linger` without running it.
- [ ] #5 Under systemd, worker hosts start in their own `systemd-run --user --scope` unit.
- [ ] #6 When installed, `dipo daemon start|stop|restart` go through `launchctl` or `systemctl --user`.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S47 (DIPO-15). After cutover: built by dipo itself, not by a hand-run agent.
<!-- SECTION:NOTES:END -->
