---
id: DIPO-77
title: Keep the local test suite under its time budget
status: To Do
assignee: []
created_date: '2026-10-13 08:44'
labels: []
milestone: m-0
dependencies: []
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
- [ ] #2 Every moved test still runs and passes in `DIPO_TEST_CI=1 bun test`, with the same test count as before the move
- [ ] #3 No test is deleted and no production code changes; each moved file keeps at least one fast representative case local
- [ ] #4 The test guidance says which tests go to `*.ci.test.ts`
<!-- AC:END -->
