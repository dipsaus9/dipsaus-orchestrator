---
id: DIPO-208
title: Keep a queued start and a pickup from taking the worker place at the same time
status: Done
assignee: []
created_date: '2026-10-18 14:32'
updated_date: '2026-10-20 08:08'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/run/places.ts
  - packages/engine/src/run/work-run.ts
  - packages/engine/src/run/compose.ts
  - packages/daemon/src/foreground.ts
  - packages/engine/test/run/
priority: medium
type: bug
ordinal: 208000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a queued resume that Places.drain starts and a story that work.run picks up can never both hold an office's worker place.

Context: review of DIPO-142 (PR #217). work.run checks workerPlaceTaken (packages/engine/src/run/work-run.ts) once, before the awaited steps of its claim: the pickup gate recheck, the claim itself and launcher.prepare. The pickup's run row, which placeHolders counts, is written only after them. Places.drain (packages/engine/src/run/places.ts) is not serialized with work.run, so a resume queued after work.run's check can be claimed and started by a drain inside that span, and the office ends with two developer sessions. A resume queued before the check is not affected: it ranks ahead of a pickup in the worker place's start order (places.ts ORDER: resume 0, pickup 2), so workerPlaceTaken is already true and the pickup skips with `capacity`. A similar race existed before between a park resume and work.run.

The serialized step is owned by Places (for example its per-office drain chain) and WorkRun takes it as a dependency. WorkRun is built in packages/daemon/src/foreground.ts (around line 793, where runs.places is at hand) and Places in packages/engine/src/run/compose.ts (around line 282), so both are in References.

```dipo
branch: "DIPO-208/serialize-worker-place"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) with work.run's claim step held open by a fake, a resume queued and drained inside that window ends with exactly one developer session and the other start skipped with `capacity` or requeued; the test fails on the base commit"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 work.run and Places.drain decide on and take an office's worker place in one serialized step per office, so at most one developer session holds it
- [x] #2 A test in packages/engine/test/run/ holds work.run's claim step open with a fake (the claim, the pickup recheck or launcher.prepare), then queues a resume and drains it inside that window, and expects exactly one developer session, with the other start skipped with `capacity` or requeued, whichever the serialized step decides
- [x] #3 The test of criterion #2 fails on the story branch's base commit and passes with the change
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M5C4CR44YSH3G9V8A9AW9W68 (Haiku, 50 turns, about $0.07, 5 min) reported done, In Review; one compound cd command was auto-denied (G7). No write outside the References. Places.serialized is a per-office FIFO chain; Places.drain and each work.run candidate's start (claim, pickup recheck, prepare and the run record) run in it, so a queued start and a pickup never hold the worker place together; a drain that finds the place held keeps its start queued. The worker's sandbox could not check out the base commit, so the reviewer ran the new test against main's code: it fails there (the drain started the resume inside the claim window as well) and passes on the branch. Fixed on top after review: the doc comment says a serialized step must never await drain or serialized of the same office. Advisories: the direct park-resume path (resumePark) is not serialized yet, filed as a gap story; the serialized step also covers launcher.start, so drains wait for a pickup's whole start. Verify outside the sandbox: 3866 tests, 0 fail; DIPO_TEST_CI=1 run and daemon tests pass (587).
<!-- SECTION:NOTES:END -->
