---
id: DIPO-271
title: Run the Claude worker inside its box
status: Refined
assignee: []
created_date: '2026-10-21 13:44'
updated_date: '2026-10-21 14:38'
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
- [ ] #1 The worker host starts claude inside the box (a long-running exec) instead of on the Mac, with the stream-json input and output dipo reads today
- [ ] #2 Inside the box the worker runs with all permissions; dipo's Bash sandbox settings, hooks and permission relay are not used for a box worker
- [ ] #3 Budgets, turn and minute caps and the live view work as today, shown by tests with a recorded box stream
- [ ] #4 The box gets the image of DIPO-266 and the web and model routes of DIPO-268 and DIPO-269; no folder of the Mac is mounted except the office package cache of DIPO-267, read-only, and the Mac is reachable from the box only as the 0021 amendment of 2026-10-21 records (the two proxies, plus the accepted risk for services that listen on all interfaces)
- [ ] #5 The box gets a plain copy of the code at the story's start commit with no .git, plus only the files the office config lists and marks as holding no real secrets (DIPO-266); nothing else is copied in, shown by a test that .git and unlisted untracked files are absent from the box
- [ ] #6 Stopping a worker (cap, budget, stop command or daemon stop) ends its claude process inside the box, not only the exec client on the Mac, shown by a test
<!-- AC:END -->
