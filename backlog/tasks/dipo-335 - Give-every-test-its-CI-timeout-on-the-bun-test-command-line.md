---
id: DIPO-335
title: Give every test its CI timeout on the bun test command line
status: Done
assignee: []
created_date: '2026-10-23 13:53'
updated_date: '2026-10-23 14:00'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - '- scripts/test.ts'
  - package.json
  - packages/testkit/README.md
  - packages/testkit/src/test-env.test.ts
  - packages/testkit/src/test-env.ts
  - scripts/test.test.ts
  - scripts/test.ts
priority: high
type: bug
ordinal: 316000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found on 2026-10-23: the macOS CI job (DIPO-316) kept failing on tests that ran past Bun's 5 s default (the Backlog CLI and real-git tests), including dipo's own story PRs. DIPO-316 set a 30 s default with setDefaultTimeout in the test preload, but a preload's setDefaultTimeout reaches only the first test file of a run (proven locally with a probe file in second place), so CI ran every later file at 5 s.

```dipo
branch: "DIPO-335/ci-test-timeout"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) scripts/test.test.ts: 30 s with DIPO_TEST_CI=1, 5 s otherwise, the caller's arguments kept, and a 6 s test in the second file of a run passes in CI mode"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 bun run test and bun run verify run bun test with --timeout 30000 when DIPO_TEST_CI=1 and 5000 otherwise, through scripts/test.ts
- [x] #2 The ineffective preload setDefaultTimeout is removed
- [x] #3 A test shows the timeout reaches a test file that is not the first of the run
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Done 2026-10-23 (maintainer session): built in the maintainer session, reviewed by a separate agent (all 3 criteria met). A preload's setDefaultTimeout reaches only the first test file of a run (proven with a probe file in second place), so DIPO-316's CI default never reached most files.
<!-- SECTION:NOTES:END -->
