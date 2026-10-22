---
id: DIPO-299
title: Make CI the verify of a box run
status: To Do
assignee: []
created_date: '2026-10-22 09:34'
updated_date: '2026-10-22 09:34'
labels:
  - 'tier:M'
  - box
  - cutover
milestone: m-1
dependencies:
  - DIPO-294
references:
  - packages/engine/src/run/verify-commit.ts
  - packages/engine/src/box/verify.ts
  - packages/engine/src/prompts/contract/implement-box.md
  - packages/engine/test/run/verify-in-box.test.ts
priority: high
type: feature
ordinal: 288000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo no longer runs verify in the box at done: at done it commits and pushes the last part, opens the story PR and starts the review and CI together, red CI goes back to the same worker, and the box prompt tells the worker to run the office's verify itself before it reports done.

Context: in the first box run (DIPO-275 on DIPO-248) dipo's verify in the box failed 305 tests that need the git program, three times, and the story parked as verify-failing although the worker caused none of them. Maintainer decision of 2026-10-22 (0021 amendment of that date): dipo prepares the box with the office's packages installed; the worker runs verify itself before done; dipo no longer runs verify in the box; CI on the story PR is the verify, started together with the review; an office without CI relies on the worker's own verify and the review. This replaces 0021 section 9 (DIPO-274) for box runs; Mac runs keep their verify until DIPO-280 removes them.

```dipo
branch: "DIPO-299/ci-verifies-box-runs"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A box run's done report no longer starts verify in the box: dipo commits and pushes the last part, opens the story PR and starts the review and CI together on that head (0019 section 7)
- [ ] #2 Red CI on a box run goes back to the same worker as a fix round through the CI loop of 0019 section 8, and the run parks verify-failing with cause ci at that loop's cap
- [ ] #3 An office whose story PRs get no CI checks is not held waiting for them: the review decides, and the run's record says that no CI ran
- [ ] #4 implement-box.md tells the worker to run the office's verify in its box before it reports done and to fix what its change broke, and no longer says that dipo runs verify at done
- [ ] #5 Tests cover: done without a verify in the box; red CI back to the worker; the CI cap; an office without CI; the prompt text
<!-- AC:END -->
