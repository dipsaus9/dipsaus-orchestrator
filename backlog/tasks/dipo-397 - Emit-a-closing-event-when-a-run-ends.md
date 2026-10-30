---
id: DIPO-397
title: Emit a closing event when a run ends
status: Refined
assignee: []
created_date: '2026-10-30 16:01'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-320
references:
  - packages/engine/src/run/
  - packages/engine/src/changelog/
  - packages/cli/src/watch-command.ts
priority: medium
type: bug
ordinal: 375000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: every run end (done, parked, dropped) emits an event on the office stream, so a client that follows the stream sees the end without polling.

Gap G13, found by the review of PR #468 (DIPO-320): a run can end without a closing event on the office stream, so `dipo watch` keeps a 15 s idle story.detail check to notice it (cli/src/watch-command.ts). The run endings are decided in one place since DIPO-373 (done, parked or dropped). Once every end emits an event, the idle check goes. 0005, 0020.

```dipo
branch: "DIPO-397/run-end-event"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) every run end path emits one closing event on the office stream"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every path that ends a run (done, parked, dropped, and a run ended at recovery) writes a change-log entry that reaches the office stream, shown by a test per path
- [ ] #2 dipo watch drops its 15 s idle story.detail check and still prints every run end, with a test that a run ending at recovery is printed
- [ ] #3 No event is emitted twice for one end
<!-- AC:END -->
