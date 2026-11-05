---
id: DIPO-446
title: >-
  Count every running story in status and watch and show each run's verify
  result
status: Refined
assignee: []
created_date: '2026-11-05 12:06'
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
priority: medium
type: bug
ordinal: 419000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want dipo status and dipo watch to count every story that is running, in review included, and to show each run's verify result, so that I can see at a glance what dipo is doing in parallel.

Found by M2's closing hand test (2026-11-05). Does not block M2. With three stories active (two developers, one reviewer), dipo daemon status said 2 active runs and the dipo watch header said 1 running, while three boxes ran. The watch lines showed verify none all the way through, though the daemon log recorded a green verify in the box for each run.

The fix: status and the watch header count the same stories the run slots count (0002: a story holds its slot from its developer through its review), and the watch line shows the verify result the box recorded. Built by dipo: it is off dipo's run path.

```dipo
branch: "DIPO-446/count-running-stories-show-verify"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) daemon-commands and watch tests: with two developers and one reviewer active, status and the watch header both count three"
    - kind: "automated"
      check: "(unit) watch tests: a run whose verify in the box was green shows verify green, not none"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 dipo daemon status counts every story that holds a run slot, in review included, the same way the run slots count them
- [ ] #2 The dipo watch header counts the same stories as dipo daemon status
- [ ] #3 A watch line shows the verify result the box recorded for the run (green or red), and none only before any verify ran
<!-- AC:END -->
