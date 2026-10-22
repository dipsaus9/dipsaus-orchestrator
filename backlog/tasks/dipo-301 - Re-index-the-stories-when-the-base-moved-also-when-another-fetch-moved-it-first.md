---
id: DIPO-301
title: >-
  Re-index the stories when the base moved, also when another fetch moved it
  first
status: Ready
assignee: []
created_date: '2026-10-22 14:25'
updated_date: '2026-10-22 16:30'
labels:
  - 'tier:S'
  - box
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/stories/feature.ts
  - packages/engine/test/stories/index.test.ts
priority: medium
type: bug
ordinal: 290000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo's story index follows the base branch even when a git fetch outside dipo moved origin/<base> before dipo's own poll fetched.

Context: in the box retest of the verify redesign (DIPO-275: DIPO-300 run run_01M5HS75YC89DVXQAEMFFT01P5 and DIPO-122 run run_01M5HY626T0A2FGPR3SEK1ERKY, 2026-10-22) the maintainer side pulled main in the office repository; dipo's poll then saw no move in its own fetch and never re-indexed, so the new story DIPO-300 stayed unknown (story.unknown) for over 10 minutes until dipo office rescan.

```dipo
branch: "DIPO-301/reindex-after-outside-fetch"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) origin/<base> moved by a fetch outside dipo before the poll: the next poll compares the last indexed commit with origin/<base> and indexes the new story"
    - kind: "automated"
      check: "(unit) a poll where origin/<base> equals the last indexed commit does not re-index"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The poll re-indexes when the commit it last indexed differs from origin/<base> after its fetch, whatever moved the ref
- [ ] #2 A test moves origin/<base> before the poll's fetch and shows the next poll indexes the new story
<!-- AC:END -->
