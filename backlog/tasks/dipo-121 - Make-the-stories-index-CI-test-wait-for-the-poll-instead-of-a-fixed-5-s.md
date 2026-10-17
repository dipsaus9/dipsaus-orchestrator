---
id: DIPO-121
title: Keep the stories index refresh CI test under its timeout
status: Done
assignee: []
created_date: '2026-10-16 11:52'
updated_date: '2026-10-17 22:55'
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
- [x] #1 The poll case and the refresh case are separate tests, or the test does fewer subprocess calls, or it sets a per-test timeout based on a measured CI runtime with the measurement stated in a comment
- [x] #2 The slowest of at least 5 CI runs of the test (or tests) is under half its timeout, stated in the PR
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M55YN03AKEZ026MZKEYNGYJM (Haiku low, 7 turns, about $0.01) split the test into a poll test and a refresh test, then parked to ask for the CI measurement (a maintainer step in the test plan). Finished on DIPO-121/stories-index-test-timeout-finish. CI measurement (criterion 2), 5 runs of the verify job of #186 at head 9bb66a7 (run 39074323685, attempts 1 to 5): refresh 2561, 3291, 3425, 2639, 3370 ms; poll 1616, 2100, 2086, 1633, 2074 ms. The refresh test is over half the default 5 s, so both tests get REMOTE_BASE_TIMEOUT_MS = 10 s with the measurement in a comment (criterion 1, third option): the slowest runs (3425 ms and 2100 ms) are under half of it. Locally (5 runs): refresh 2.19 to 2.24 s, poll 1.38 to 1.39 s. The old combined test also covered a refresh right after a poll's fetch; that interaction is no longer tested on its own. Verify outside: 3179 pass, 2 skip, 0 fail.
<!-- SECTION:NOTES:END -->
