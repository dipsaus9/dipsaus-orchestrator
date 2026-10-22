---
id: DIPO-304
title: Open a missed story PR also after the review ended
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
  - packages/engine/src/story-pr/records.ts
  - packages/engine/src/story-pr/prs.ts
  - packages/engine/test/story-pr/prs.test.ts
priority: medium
type: bug
ordinal: 293000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a story that is In Review without a story PR gets one from the PR poll, also when its run already ended as reviewed.

Context: in the box retest of the verify redesign (DIPO-275: DIPO-300 run run_01M5HS75YC89DVXQAEMFFT01P5 and DIPO-122 run run_01M5HY626T0A2FGPR3SEK1ERKY, 2026-10-22) DIPO-300's review finished while story PRs were off; after they were switched on, runsWithoutPr never picked the run up because it only selects runs with end_kind in-review and a push after the end. The PR had to be opened by hand (#337).

```dipo
branch: "DIPO-304/open-missed-story-pr"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 runsWithoutPr also selects runs that ended as reviewed whose story is still In Review with a live claim and no story PR
- [ ] #2 The PR opened then carries the stored review verdict in its status block
- [ ] #3 A test switches story PRs on after the review and shows the PR opens on the next poll
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-22: combined into DIPO-152 (maintainer, M1 speed-up)
<!-- SECTION:NOTES:END -->
