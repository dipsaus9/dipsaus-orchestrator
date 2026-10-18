---
id: DIPO-208
title: Keep a queued start and a pickup from taking the worker place at the same time
status: Refined
assignee: []
created_date: '2026-10-18 14:32'
updated_date: '2026-10-18 14:32'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/run/places.ts
  - packages/engine/src/run/work-run.ts
  - packages/engine/test/run/
priority: medium
type: bug
ordinal: 208000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a queued resume that Places.drain starts and a story that work.run picks up can never both hold an office's worker place.

Context: review of DIPO-142 (PR #217). work.run checks workerPlaceTaken (packages/engine/src/run/work-run.ts) once, before its awaited claim steps. Places.drain (packages/engine/src/run/places.ts) is not serialized with work.run, so a queued resume can take the worker place between that check and the pickup's claim, leaving two developer sessions in one office. The window is narrow, and a similar race existed before between a park resume and work.run.

```dipo
branch: "DIPO-208/serialize-worker-place"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) with a resume queued for the worker place, a drain and a work.run that start together end with one developer session, and the other start reports the place taken"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 work.run and Places.drain decide on the worker place in one serialized step per office, so at most one developer session holds it
- [ ] #2 A test in packages/engine/test/run/ starts a drain of a queued resume and a work.run pickup together, with the drain's start held open by a fake, and expects exactly one developer session and the place-taken result for the other
<!-- AC:END -->
