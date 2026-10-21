---
id: DIPO-289
title: Keep a worker's live question and its answer when the run ends
status: Refined
assignee: []
created_date: '2026-10-21 20:24'
updated_date: '2026-10-21 20:24'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/hooks/permissions.ts
  - packages/engine/src/run/park.ts
  - packages/engine/test/hooks/
type: bug
ordinal: 278000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker's question that is live when its run ends, or that is answered while the run is ending, always reaches the run's next session or its park, and no carried question is left open after its park is resolved.

Context: DIPO-272 carries a live worker question into the park when a cap or stop ends the run. Its review (PR #320) found edges where the question or the maintainer's answer is lost.

```dipo
branch: "DIPO-289/keep-question-at-end"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An answer given after a cap or stop began, but before the run's end is ingested, is held for the next session (delivered on resume) instead of being sent to the stopping worker
- [ ] #2 An open question that a run being ended has already let go of, but that its park has not carried yet, takes an answer as held instead of refusing it
- [ ] #3 A worker that exits on its own while its question is live leaves the question to the park its exit decision makes; when no park follows, the question closes
- [ ] #4 Resolving a park another way (resume, drop, reconcile) closes its carried question as expired, and a later park of the same story is tested
- [ ] #5 Tests cover each case
<!-- AC:END -->
