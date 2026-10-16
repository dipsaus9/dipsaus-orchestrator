---
id: DIPO-121
title: Make the stories index CI test wait for the poll instead of a fixed 5 s
status: To Do
assignee: []
created_date: '2026-10-16 11:52'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/test/stories
priority: medium
type: chore
ordinal: 111000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: packages/engine/test/stories/index.ci.test.ts no longer times out at random in CI.

Context: "indexes a story merged to the remote base at the next poll" hit the 5000 ms bun test timeout on PR #142 and passed on rerun and three local runs. A required check that fails at random costs a rerun on every PR it hits.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The test waits on the index event or the injected clock, not on wall time, or states a measured timeout with its reason
- [ ] #2 The test passes 20 runs in a row with DIPO_TEST_CI=1
<!-- AC:END -->
