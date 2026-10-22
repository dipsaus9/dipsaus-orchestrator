---
id: DIPO-300
title: >-
  Harden three tests and a code comment left from the DIPO-227, 229 and 136
  reviews
status: Done
assignee: []
created_date: '2026-10-22 11:35'
updated_date: '2026-10-22 14:27'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies:
  - DIPO-183
  - DIPO-228
references:
  - packages/engine/test/run/work-run.test.ts
  - packages/daemon/src/foreground.ts
  - packages/daemon/test/unit/
  - packages/contract/src/errors.ts
priority: low
type: chore
ordinal: 289000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the DIPO-229 claim-window test waits for a condition instead of a fixed number of microtask ticks, the daemon's StoryPlanning wiring has a test, and the office.refused comment names every cause it is used for.

Context: advisories of three reviews on 2026-10-20. (1) DIPO-229 (PR #278): settle() in packages/engine/test/run/work-run.test.ts waits 50 microtask ticks for a park answer to reach its serialized step; if a later change puts a macrotask before that step, the claim-window test still passes but no longer catches the race. (2) DIPO-227 (PR #279): packages/daemon/src/foreground.ts builds StoryPlanning inside serve() with `probe: systemProcessProbe(platform)`; no daemon test builds serve()'s dependencies, so the wiring is checked only by tsc through the required field. Daemon unit tests live in packages/daemon/test/unit/. (3) DIPO-136 (PR #282): office.setPrivacy answers office.refused for a failed write of .dipo/office.local.yaml; the comment on office.refused in packages/contract/src/errors.ts says only "an office whose engine instance would not load".

Refiled from DIPO-248 on 2026-10-22: the first box run parked DIPO-248 as verify-failing (missing git in the box), and a parked story cannot be resumed yet (DIPO-157), so DIPO-248 is dropped and this story is the box retest of the verify redesign. DIPO-248's branch is kept for reference.

```dipo
branch: "DIPO-300/harden-tests-and-refused-comment"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) work-run.test.ts: the claim-window test waits until the answer's intent row is stored (or the unpark mock resolves) before it opens the claim gate, and still fails with the DIPO-229 fix reverted"
    - kind: "automated"
      check: "(unit) a daemon unit test calls the factored-out StoryPlanning dependency builder and finds the probe it was given"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The claim-window test of DIPO-229 in packages/engine/test/run/work-run.test.ts waits for a condition that is always reached (the answer's intent row stored, or the unpark mock resolved) instead of a fixed count of microtask ticks, and settle() no longer counts ticks
- [x] #2 The StoryPlanning dependencies serve() builds in packages/daemon/src/foreground.ts come from an exported function that takes the probe, and a test in packages/daemon/test/unit/ shows that the dependencies it returns carry the given probe
- [x] #3 The comment on office.refused in packages/contract/src/errors.ts names both causes: an office whose engine instance would not load, and a refused write of an office file such as .dipo/office.local.yaml
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built by dipo in a box (retest of DIPO-275); PR #337 opened by hand (story PRs were off until #336). dipo's reviewer approved with an advisory on criterion 1 (the wait condition was already true when the wait started); fixed on the branch before the merge (39b0a8a4: wait for the answer's worker place step, slower unpark mock; shown to fail with the DIPO-229 fix reverted).
<!-- SECTION:NOTES:END -->
