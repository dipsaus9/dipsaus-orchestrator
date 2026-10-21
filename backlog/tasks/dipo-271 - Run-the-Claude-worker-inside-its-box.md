---
id: DIPO-271
title: Run the Claude worker inside its box
status: In Review
assignee: []
created_date: '2026-10-21 13:44'
updated_date: '2026-10-21 17:29'
labels:
  - 'tier:L'
  - cutover
  - box
milestone: m-1
dependencies:
  - DIPO-266
  - DIPO-268
  - DIPO-269
  - DIPO-270
references:
  - packages/engine/src/workers/claude-cli/
  - packages/engine/src/host/
  - packages/engine/src/run/launch.ts
  - packages/daemon/src/runs.ts
  - packages/engine/test/workers/
  - packages/engine/src/box/
  - packages/engine/test/box/
  - packages/engine/src/workers/hold.ts
  - packages/engine/src/workers/types.ts
  - packages/engine/src/run/work-run.ts
  - packages/engine/src/run/compose.ts
  - packages/engine/test/run/start.test.ts
  - packages/contract/src/office.ts
  - packages/contract/src/version.ts
  - packages/contract/schema/commands.schema.json
  - packages/cli/src/run-command.ts
  - packages/cli/src/run-command.test.ts
  - packages/cli/src/index.ts
  - packages/daemon/src/foreground.ts
  - packages/daemon/src/login.ts
  - packages/daemon/src/login.test.ts
  - packages/daemon/test/unit/box-runs.test.ts
priority: high
type: feature
ordinal: 260000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker's claude process runs inside its story's box with all permissions, its live stream reaches dipo as today, so budgets, caps and the live view keep working, and no hook, permission relay or socket of dipo is reachable from inside the box.

Context: Decision 0021 (worker isolation, DIPO-263) and the probe results of DIPO-264 (tools/box-probe/RESULTS.md and the 0021 amendment of 2026-10-21).

```dipo
branch: "DIPO-271/worker-in-box"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The worker host starts claude inside the box (a long-running exec) instead of on the Mac, with the stream-json input and output dipo reads today
- [x] #2 Inside the box the worker runs with all permissions; dipo's Bash sandbox settings, hooks and permission relay are not used for a box worker
- [x] #3 Budgets, turn and minute caps and the live view work as today, shown by tests with a recorded box stream
- [x] #4 The box gets the image of DIPO-266 and the web and model routes of DIPO-268 and DIPO-269; no folder of the Mac is mounted except the office package cache of DIPO-267, read-only, and the Mac is reachable from the box only as the 0021 amendment of 2026-10-21 records (the two proxies, plus the accepted risk for services that listen on all interfaces)
- [x] #5 The box gets a plain copy of the code at the story's start commit with no .git, plus only the files the office config lists and marks as holding no real secrets (DIPO-266); nothing else is copied in, shown by a test that .git and unlisted untracked files are absent from the box
- [x] #6 Stopping a worker (cap, budget, stop command or daemon stop) ends its claude process inside the box, not only the exec client on the Mac, shown by a test
- [x] #7 The image build's proxy runs only for the length of a build and applies the box web proxy's address rules (0021 amendment of 2026-10-21, DIPO-266)
- [x] #8 A box-token hold (DIPO-269) stays until the maintainer replaces the token with dipo login box; a passing launch check alone does not lift it
- [x] #9 At the end of every box run dipo calls checkBoxAfterRun (DIPO-269), and at daemon start it calls sweepTokenCheckLeftovers, shown by tests
- [x] #10 dipo's web and model proxies for a box network start only after the first box on it is running, because the network's address exists on the Mac only then (0021 amendment of 2026-10-21, DIPO-268), shown by a test
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Box worker chosen per run with `dipo run <ID> --box` (work.run's new optional `box`); the run directory records it (box-run.json), so every later developer session of the run plans in its box. A reviewer stays on the Mac until DIPO-276. The old Mac path stays the default until DIPO-280.

- BoxWorkers (box/workers.ts): create at the launch's setup (image through a build proxy that runs only for one build on the builder network's host address, found with `container builder start` then the default network's gateway; the box on the host-only network, no Mac folder, the package cache only when given; the start commit from `git archive` plus the listed box.files from `_base`), session per developer session (box started, web route and model proxy acquired only now, system file and Safe-Chain CA copied to /dipo), finish at the run's end (checkBoxAfterRun, delete, routes released), close at daemon stop (stops every box).
- planInBox: `container exec --interactive` of claude with stream-json, `--permission-mode bypassPermissions`, no settings file, hooks or relay; box env = boxModelEnvironment + HTTPS_PROXY/HTTP_PROXY + NODE_EXTRA_CA_CERTS (Safe-Chain CA) + IS_SANDBOX and the session state events; the plan's stopCommand (`container stop`) runs in the host at SIGTERM/SIGKILL and after the exit.
- The box-token hold is sticky (hold.ts) and kept in <state>/box-token-hold.json; `dipo login box` removes the record after storing the token, which lifts it at the daemon's next look.

Only a live run can confirm: IS_SANDBOX lets root use bypassPermissions; the system/init key source in a box; `container builder start` on a running builder; the build proxy's listen on the default network's gateway; `container copy dir/.` into an existing /dipo. The opt-in test packages/engine/test/box/worker.box.test.ts (DIPO_TEST_BOX=1) covers them; it was not run.
<!-- SECTION:NOTES:END -->
