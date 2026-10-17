---
id: DIPO-121
title: Keep the stories index refresh CI test under its timeout
status: In Progress
assignee: []
created_date: '2026-10-16 11:52'
updated_date: '2026-10-17 22:10'
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

Context: "indexes a story merged to the remote base at the next poll, and at once on a refresh" hit bun's default 5000 ms per-test timeout on PR #142, and passed on rerun and in three local runs. The test already drives the poll with the injected clock and awaits index.whenIdle. The time goes to about a dozen real git and backlog CLI subprocess calls (clone, three rounds of backlog create, commit and push, then fetches). A required check that fails at random costs a rerun on every PR it hits.

```dipo
branch: "DIPO-121/stories-index-test-timeout"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(ci) DIPO_TEST_CI=1 bun test packages/engine/test/stories/index.ci.test.ts passes, each test well under its timeout"
    - kind: "manual"
      check: "(ci) rerun the verify job of the story PR until it has at least 5 runs and read the test times from the logs"
      expect: "the slowest run of each test is under half its timeout; the PR states the times"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The poll case and the refresh case are separate tests, or the test does fewer subprocess calls, or it sets a per-test timeout based on a measured CI runtime with the measurement stated in a comment
- [ ] #2 The slowest of at least 5 CI runs of the test (or tests) is under half its timeout, stated in the PR
<!-- AC:END -->
