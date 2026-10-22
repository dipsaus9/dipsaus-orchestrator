---
id: DIPO-306
title: >-
  Keep the story PR's status block true after the review and before the merge
  slot
status: To Do
assignee: []
created_date: '2026-10-22 14:26'
updated_date: '2026-10-22 18:16'
labels:
  - 'tier:S'
  - box
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/story-pr/body.ts
  - packages/engine/test/story-pr/title-body.test.ts
priority: medium
type: bug
ordinal: 295000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the status block of dipo's story PR shows the stored review verdict once the review ends, and says who merges as long as dipo does not merge itself.

Context: in the box retest of the verify redesign (DIPO-275: DIPO-300 run run_01M5HS75YC89DVXQAEMFFT01P5 and DIPO-122 run run_01M5HY626T0A2FGPR3SEK1ERKY, 2026-10-22) PR #339 kept "review: pending" after the reviewer approved, and said "dipo merges after review and green required checks" while the merge slot (DIPO-150) is not built and the maintainer side merges.

```dipo
branch: "DIPO-306/pr-status-block"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 After a review round the PR body's review line shows the stored verdict and round
- [ ] #2 Until the merge slot merges story PRs, the merge line says the maintainer merges
- [ ] #3 Tests cover both lines
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-22: combined into DIPO-152 (maintainer, M1 speed-up)
<!-- SECTION:NOTES:END -->
