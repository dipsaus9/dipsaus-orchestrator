---
id: DIPO-79
title: Bring the local test suite back under its time budget again
status: Done
assignee:
  - '@claude'
created_date: '2026-10-13 14:03'
updated_date: '2026-10-13 14:45'
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
- [x] #1 Local `bun test` (no DIPO_TEST_CI) finishes in about 45 seconds or less on the maintainer's machine, measured before and after in the PR body, with the 15 slowest test files listed before and after
- [x] #2 Every moved test still runs and passes in `DIPO_TEST_CI=1 bun test`; CI runs every test that ran before the move
- [x] #3 No test is deleted and no production code changes; every rule whose full test moved to CI keeps a fast local test (0017)
- [x] #4 packages/testkit/README.md names the per-test budget that triggers a move, so later stories keep the suite under budget
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Local bun test median 54.77 s before (54.10, 54.77, 58.55), 44.76 s after (44.64, 44.76, 45.95). Full DIPO_TEST_CI=1 bun test: 2168 tests before, 2171 after (three new fast local versions; nothing deleted). Scope additions: none; the new helper modules (test/gate/gated-office.ts, test/git/helpers.ts, test/worktree/setup-harness.ts) are under packages/*/test/.

Review passed; advisory notes fixed (empty describe, one-item loops, harness comment).
<!-- SECTION:NOTES:END -->
