---
id: DIPO-79
title: Bring the local test suite back under its time budget again
status: To Do
assignee: []
created_date: '2026-10-13 14:03'
updated_date: '2026-10-13 14:03'
labels:
  - 'tier:S'
milestone: m-0
dependencies: []
references:
  - packages/*/test/
  - packages/*/src/**/*.test.ts
  - test/
  - packages/testkit/README.md
documentation:
  - docs/decisions/0017-testing-strategy-and-configuration.md
priority: high
type: chore
ordinal: 70000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: local `bun test` on the maintainer's machine is back to about 45 seconds; it has grown to 57-61 s since DIPO-77, at the 60 s budget of 0017, while CI still runs every test.

Context: DIPO-77 did the first round. Since then DIPO-35, 39, 58, 63, 71, 73 and 78 added tests. Use the DIPO-77 approach and the guidance in packages/testkit/README.md: move the slowest integration cases (real git, bare remotes, the pinned Backlog CLI, compiled binaries) into `*.ci.test.ts` siblings, keep a fast representative case of every rule local, delete nothing, change no production code.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Local `bun test` (no DIPO_TEST_CI) finishes in about 45 seconds or less on the maintainer's machine, measured before and after in the PR body, with the 15 slowest test files listed before and after
- [ ] #2 Every moved test still runs and passes in `DIPO_TEST_CI=1 bun test`; CI runs every test that ran before the move
- [ ] #3 No test is deleted and no production code changes; every rule whose full test moved to CI keeps a fast local test (0017)
- [ ] #4 packages/testkit/README.md names the per-test budget that triggers a move, so later stories keep the suite under budget
<!-- AC:END -->
