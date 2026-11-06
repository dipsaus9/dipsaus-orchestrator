---
id: DIPO-446
title: >-
  Count every running story in status and watch and remove the verify field that
  is always none
status: Done
assignee: []
created_date: '2026-11-05 12:06'
updated_date: '2026-11-06 09:19'
labels:
  - 'tier:S'
milestone: m-2
dependencies: []
references:
  - packages/cli/src/daemon-commands.ts
  - packages/cli/src/daemon-commands.test.ts
  - packages/cli/src/watch-command.ts
  - packages/cli/src/watch-command.test.ts
  - packages/engine/src/overview/summary.ts
  - packages/engine/src/records/run-records.ts
  - packages/engine/src/create/steps.ts
  - packages/engine/src/run-state/places.ts
  - packages/engine/src/views/work.ts
  - packages/client/src/store/office-store.ts
  - packages/contract/src/work.ts
modified_files:
  - packages/cli/src/daemon-commands.test.ts
  - packages/cli/src/daemon-commands.ts
  - packages/cli/src/index.ts
  - packages/cli/src/lifecycle-commands.test.ts
  - packages/cli/src/watch-command.test.ts
  - packages/cli/src/watch-command.ts
  - packages/client/test/unit/client.test.ts
  - packages/client/test/unit/lifecycle.test.ts
  - packages/client/test/unit/live-updates.test.ts
  - packages/client/test/unit/office-store.test.ts
  - packages/client/test/unit/recovery.test.ts
  - packages/client/test/unit/supervisor.test.ts
  - packages/contract/schema/events.schema.json
  - packages/contract/schema/reads.schema.json
  - packages/contract/schema/shared.schema.json
  - packages/contract/schema/work.schema.json
  - packages/contract/src/software.ts
  - packages/contract/src/work.ts
  - packages/contract/test/fixtures.ts
  - packages/engine/src/create/control.ts
  - packages/engine/src/create/steps.ts
  - packages/engine/src/overview/index.ts
  - packages/engine/src/overview/summary.ts
  - packages/engine/src/run/review-rounds.ts
  - packages/engine/src/run/work-run.ts
  - packages/engine/src/views/work.ts
  - packages/engine/test/create/control.test.ts
  - packages/engine/test/create/surface.test.ts
  - packages/engine/test/retention/retention.test.ts
  - packages/engine/test/run-state/places.test.ts
  - packages/engine/test/run/work-run.test.ts
  - packages/engine/test/stories/views.test.ts
  - packages/engine/test/views/derive.test.ts
  - packages/tui/src/detail.test.tsx
  - packages/tui/src/detail.tsx
priority: medium
type: bug
ordinal: 419000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want dipo status and dipo watch to count every story that is running, in review included, and to stop showing a verify field that is always none, so that I can see at a glance what dipo is doing in parallel.

Found by M2's closing hand test (2026-11-05). Does not block M2. With three stories active (two developers, one reviewer), dipo daemon status said 2 active runs and the dipo watch header said 1 running, while three boxes ran. The status count is activeRunCount in packages/engine/src/overview/summary.ts, built on activeRuns (packages/engine/src/records/run-records.ts) and wired in packages/engine/src/create/steps.ts; the watch header counts the client store's work views (packages/client/src/store/office-store.ts). The run slots that decide what runs are in packages/engine/src/run-state/places.ts (0002: a story holds its slot from its developer through its review).

The verify field: packages/engine/src/views/work.ts sets verify to none for every run, because dipo stores no verify result of its own (DIPO-342; the box's verify decides done). The maintainer chose to remove the field rather than store a result.

The fix: status and the watch header count the stories that hold a run slot, the same set the run slots use; a scan session, which holds no slot, is shown apart from that count if one runs. The verify field leaves the work view, its contract and the watch lines. Built by dipo: it is off dipo's run path.

```dipo
branch: "DIPO-446/count-running-stories-drop-verify"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) daemon-commands and watch tests: with two developers and one reviewer active, status and the watch header both count three running stories"
    - kind: "automated"
      check: "(unit) watch tests: the watch lines no longer show a verify field"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 dipo daemon status counts the stories that hold a run slot, in review included, the same set the run slots use
- [x] #2 The dipo watch header counts the same stories as dipo daemon status
- [x] #3 A scan session, which holds no run slot, is shown apart from the running-stories count when one runs
- [x] #4 The verify field that is always none is removed from the work view, its contract and the watch lines
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-06 09:19 UTC
- Criteria met: 4 of 4 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 1, failed 0
- Budget used: 196,230 of 300,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 0
<!-- SECTION:FINAL_SUMMARY:END -->
