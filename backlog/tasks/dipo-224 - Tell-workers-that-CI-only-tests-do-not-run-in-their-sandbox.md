---
id: DIPO-224
title: Tell workers that CI-only tests do not run in their sandbox
status: In Review
assignee: []
created_date: '2026-10-19 23:02'
updated_date: '2026-10-20 09:38'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/prompts/contract/implement.md
  - packages/engine/test/prompts/golden/system-implement-developer.md
  - packages/engine/test/prompts/system.test.ts
priority: medium
type: enhancement
ordinal: 224000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the worker contract says that CI-only tests do not run in the worker sandbox and that CI runs them, so a worker no longer runs them with DIPO_TEST_CI set and spends turns on failures it cannot tell from its own.

Context: M1a runs of 2026-10-19 and 2026-10-20. The worker of DIPO-194 ran `DIPO_TEST_CI set bun test` in its sandbox and got 28 failures, the sandbox-exec tests failing with EPERM on mkdtemp of /tmp/dipo-sx-*, which it could not tell from failures of its change. The worker of DIPO-200 could not run the CI test its story asked for. 0017 section 1: CI-only files are named *.ci.test.ts and register their describe only when DIPO_TEST_CI set; local verify and workers skip them, and CI sets the variable. The engine's verify at done does not set it (no use in packages/engine/src). The contract in packages/engine/src/prompts/contract/implement.md says "You may run tests" in "What the engine does" and nothing on CI-only tests. The contract goes to every office, so the sentence names CI-only tests in general, with this repository's convention as the example. The change is prompt text and its golden file only.

```dipo
branch: "DIPO-224/contract-ci-only-tests"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) system.test.ts: the implement contract names CI-only tests right after the sentence on running tests, and the test that it holds no id, date, path or count (no digit) still passes"
    - kind: "automated"
      check: "(unit) the system prompt golden test passes with the new contract sentence, and system.test.ts finds the sentence with toContain"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The What the engine does section of packages/engine/src/prompts/contract/implement.md says, right after the sentence on running tests, that tests the project runs only in CI (for example `*.ci.test.ts` files that run only when `DIPO_TEST_CI` is set) do not run in the worker sandbox, that the worker neither runs them nor sets that variable, and that a CI-only test the story asks for is written and left to CI, which runs it
- [x] #2 packages/engine/test/prompts/golden/system-implement-developer.md holds the new contract text and packages/engine/test/prompts/system.test.ts checks the new sentence with toContain, and the existing test that the contract holds no id, date, path or count keeps passing, so the new text has no digit
<!-- AC:END -->
