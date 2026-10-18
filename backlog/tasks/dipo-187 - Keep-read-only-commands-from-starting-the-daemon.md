---
id: DIPO-187
title: Keep read-only commands from starting the daemon
status: Ready
assignee: []
created_date: '2026-10-17 20:30'
updated_date: '2026-10-18 10:03'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/client/src/node/lifecycle/lifecycle.ts
  - packages/client/src/node/lifecycle/index.ts
  - packages/client/test/unit/lifecycle.test.ts
  - packages/cli/src/index.ts
  - packages/cli/src/index.test.ts
  - packages/cli/src/office-commands.ts
  - packages/cli/src/office-commands.test.ts
  - packages/cli/src/gate-command.ts
  - packages/cli/src/gate-command.test.ts
  - packages/cli/src/run-command.ts
  - packages/cli/src/run-command.test.ts
  - packages/cli/src/stats-command.ts
  - packages/cli/src/stats-command.test.ts
  - packages/cli/src/watch-command.ts
  - packages/cli/src/watch-command.test.ts
  - packages/cli/src/daemon-commands.ts
  - packages/cli/src/daemon-commands.test.ts
priority: high
type: bug
ordinal: 176000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo run --dry-run, dipo gate and the other read-only commands never start the daemon; when none answers they say the daemon is not running and how to start it, so a read never runs recovery or migrations on whatever state the environment points at.

Context: seen 2026-10-17. A dry run without the temp DIPO_HOME found no daemon, started one on the maintainer's real state, and that daemon ran recovery and migrated the state database. Every office command connects through withOffice (packages/cli/src/office-commands.ts), which calls withDaemon (packages/cli/src/daemon-commands.ts), and connectDaemon in packages/cli/src/index.ts, which calls connectOrStart (packages/client/src/node/lifecycle/lifecycle.ts): when no daemon answers, it starts one unless daemon.autostart is false. The dry run's own header says "Nothing is claimed, created, stored or started" (packages/cli/src/run-command.ts), which the autostart breaks. The CLI already prints DaemonNotRunningError with START_HINT.

0006 decision 5 and its answered open question 4 say any client command starts the daemon when it is not running. This story changes that for read-only commands, so it needs an 0006 amendment; the maintainer approved it on 2026-10-18 and it is in docs/decisions/0006-daemon-and-ipc.md (Amendments, 2026-10-18, DIPO-187). This story does not edit docs/decisions/. dipo tui and dipo run keep their autostart, since dipo tui it is the main client.

```dipo
branch: "DIPO-187/read-only-commands-no-autostart"
unknowns:
  - q: "0006 decision 5 says any client command starts the daemon. Do you approve an amendment that read-only commands never start it, and which commands are read-only: dipo gate and dipo run --dry-run only, or also dipo stats and dipo watch (dipo tui keeps autostart)?"
    status: "resolved"
    answer: "Approved by the maintainer on 2026-10-18: dipo gate, dipo run --dry-run, dipo stats and dipo watch never start the daemon; dipo tui and dipo run keep the autostart (0006 amendment of 2026-10-18, DIPO-187)."
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) with a fake lifecycle and no daemon, dipo gate, dipo run --dry-run, dipo stats and dipo watch print the not-running line with the start hint, exit non-zero and never call start"
    - kind: "automated"
      check: "(unit) dipo run without --dry-run still calls start when no daemon answers and autostart is on"
    - kind: "manual"
      check: "(live) with a fresh temp DIPO_HOME exported first and no daemon running, run dipo run --dry-run in this repository"
      expect: "it prints that the daemon is not running and how to start it; dipo daemon status still says not running; no state database exists under the temp DIPO_HOME"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 packages/client/src/node/lifecycle/lifecycle.ts exports a connect that never starts the daemon and throws DaemonNotRunningError when none answers; connectOrStart keeps its behaviour
- [ ] #2 dipo gate, dipo run --dry-run, dipo stats and dipo watch connect without starting the daemon; with no daemon running they print the not-running line with START_HINT (packages/cli/src/daemon-commands.ts), exit non-zero, and a test shows the lifecycle start was never called
- [ ] #3 dipo run without --dry-run and the commands that change state still start the daemon unless daemon.autostart is false, and their existing autostart tests pass
- [ ] #4 The HELP text in packages/cli/src/index.ts names the commands that never start the daemon, next to the line that says commands that need the daemon start it
<!-- AC:END -->
