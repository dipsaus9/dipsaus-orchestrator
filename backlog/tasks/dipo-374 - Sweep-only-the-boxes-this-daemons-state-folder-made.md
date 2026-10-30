---
id: DIPO-374
title: Sweep only the boxes this daemon's state folder made
status: Done
assignee: []
created_date: '2026-10-29 09:29'
updated_date: '2026-10-30 16:40'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-351
references:
  - packages/engine/src/box/workers.ts
  - packages/engine/src/box/build-box.ts
  - packages/engine/test/box/
priority: medium
type: bug
ordinal: 354000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a daemon's start sweep deletes only the helper boxes its own state folder made, and real-box tests delete the boxes they make, so a test and a daemon on one Mac never delete each other's boxes and no box leaks.

Found on 2026-10-29 during the cutover (DIPO-351): a build box from a builder's real-box test (dipo-build-af55644ab8514be2, 14 CPUs, 48 GB) ran for about 20 hours because tests use their own DIPO_HOME and no daemon ever sweeps it; and the other way round, a temp daemon's start sweep deleted the DIPO-336 box test's build box mid-build. box/workers.ts deletes every dipo-fill-*, dipo-build-*, dipo-safe-chain-* and dipo-review-* box at daemon start. 0008.

```dipo
branch: "DIPO-374/box-sweep-ownership"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the start sweep deletes only boxes labelled with its own state folder"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Every box dipo makes carries a second label (for example dipo.home) naming the state folder that made it, the existing run-id label stays as reconcile reads it, and the start sweep deletes only helper boxes (fill, build, Safe-Chain, review) with its own state folder's label
- [x] #2 Tests: a helper box with this folder's label is deleted; one without the label or with another folder's label is kept; a dipo-<run id> run box and a test box (TEST_BOX_RUN_PREFIX) are never touched by the helper sweep. Boxes made before this change have no label and are kept once, which is accepted
- [x] #3 Each real-box test deletes the boxes it made in afterAll, also when it fails, and a leaked box from an earlier run is reported by the next run of that test
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Every box dipo makes carries a dipo.state label (sha256 of the state folder's real path, resolved through the deepest existing parent when the folder does not exist yet) next to the unchanged run-id label, and the daemon's start sweep deletes a fill, build, Safe-Chain or reviewer box only when that label equals its own; run boxes, test boxes, unlabelled boxes and other folders' boxes are kept. Real-box tests give each run of a file its own label, delete their boxes in afterAll even when a test fails, and report leftovers of an earlier run. ADR 0008's sentence on the left Safe-Chain box and one Replaced line updated, approved by the maintainer.
<!-- SECTION:FINAL_SUMMARY:END -->
