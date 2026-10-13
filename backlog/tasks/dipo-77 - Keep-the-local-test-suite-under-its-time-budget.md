---
id: DIPO-77
title: Keep the local test suite under its time budget
status: To Do
assignee: []
created_date: '2026-10-13 08:44'
updated_date: '2026-10-13 09:27'
labels:
  - testing
milestone: m-0
dependencies: []
references:
  - packages/engine/test/worktree/claim.test.ts
  - packages/engine/test/worktree/claim.ci.test.ts
  - packages/engine/test/stories/index.test.ts
  - packages/engine/test/stories/index.ci.test.ts
  - packages/engine/test/backlog/lane/lane.test.ts
  - packages/engine/test/backlog/lane/lane.ci.test.ts
  - packages/engine/test/backlog/lane/failures.test.ts
  - packages/engine/test/backlog/lane/failures.ci.test.ts
  - packages/engine/test/backlog/lane/replay.test.ts
  - packages/engine/test/backlog/lane/replay.ci.test.ts
  - packages/engine/test/scan/profiles.test.ts
  - packages/engine/test/scan/profiles.ci.test.ts
  - packages/testkit/README.md
  - packages/engine/test/worktree/claim-reuse.test.ts
priority: high
type: chore
ordinal: 68000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: local `bun test` on the maintainer's machine is back to about 40 seconds (it had grown to about 60-68 s, at the budget of 0017), while CI still runs every test.

The slowest integration cases (real git repositories, bare remotes, the pinned Backlog CLI) move into `*.ci.test.ts` siblings that register only when `DIPO_TEST_CI=1` (0017 section 1). Fast representative cases of each behavior stay local. No production code changes and no test is deleted.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Local `bun test` (no DIPO_TEST_CI) finishes in about 45 seconds or less on the maintainer's machine, measured before and after in the PR body
- [ ] #2 Every moved test still runs and passes in `DIPO_TEST_CI=1 bun test`; CI runs every test that ran before the move
- [ ] #3 No test is deleted and no production code changes; each moved file keeps at least one fast representative case local
- [ ] #4 Every rule whose full test moved to CI keeps a fast local test (0017: correctness rules never go CI only)
- [ ] #5 The test guidance says which tests go to `*.ci.test.ts` and how to write the fast local version
<!-- AC:END -->
