---
id: DIPO-233
title: Keep the Backlog CLI gate test from timing out on a busy machine
status: Done
assignee: []
created_date: '2026-10-20 10:40'
updated_date: '2026-10-20 14:55'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/test/gate/story-gate.test.ts
priority: medium
type: bug
ordinal: 233000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the local Ready gate test on the pinned Backlog CLI no longer fails at Bun's 5 second default when the machine is busy, so verify does not go red on a slow run.

Context: M1a runs of 2026-10-20. The test "story.gate returns every failure of a failing story and stores nothing; unreadable inputs answer contract codes" in packages/engine/test/gate/story-gate.test.ts runs withGatedOffice (packages/engine/test/gate/gated-office.ts): a temp repository with a remote, real git and the pinned Backlog CLI for task edits and reads, all in one it() with no limit of its own. Alone on an idle machine it took 3.8 s on 2026-10-20; it timed out at 5000 ms in a verify while a dipo run worked (that verify took 191 s instead of about 115 s), and a worker's verify hit the same. 0017, Timeouts: the Bun default of 5000 ms stays for unit tests, a slower integration test sets its own limit with the third argument of it(name, fn, timeoutMs), and a raised timeout never lifts the 60 second total budget. DIPO-79 moved the pickup-mode and archive cases into story-gate.ci.test.ts for the time budget and kept this test local; the file comments of both files say so.

```dipo
branch: "DIPO-233/gate-cli-test-timeout"
unknowns:
  - q: "How does the CLI-backed story.gate test stop timing out? (a) It stays in story-gate.test.ts with its own limit of 30000 ms, the third argument of it(), as 0017 sets for a slower integration test. (b) It moves into story-gate.ci.test.ts under the DIPO_TEST_CI guard, so local verify and workers skip it and CI runs it; the local suite loses its only test of story.gate on the real CLI and saves about 4 s. Recommended: (a): 0017 names this way for a slow integration test, every local and worker verify keeps catching gate regressions on the real CLI, and the 4 s it takes fit the local budget."
    status: "resolved"
    answer: "A (maintainer, 2026-10-20): the test keeps its place in story-gate.test.ts with its own limit of 30000 ms, the third argument of it(), as 0017 allows for a slower integration test; no ADR note."
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the story.gate test in story-gate.test.ts passes 30000 as the third argument of it() and still registers without DIPO_TEST_CI"
    - kind: "automated"
      check: "(unit) the file comment of story-gate.test.ts says why the story.gate test has its own limit of 30000 ms"
    - kind: "automated"
      check: "(unit) bun test packages/engine/test/gate passes"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 In packages/engine/test/gate/story-gate.test.ts the test "story.gate returns every failure of a failing story and stores nothing; unreadable inputs answer contract codes" passes a limit of 30000 ms as the third argument of it(), as 0017's Timeouts rule sets for a slower integration test, and it stays in that local file with no DIPO_TEST_CI guard
- [x] #2 The file comment of story-gate.test.ts says why that test has its own limit: it runs real git and the pinned Backlog CLI several times, took about 4 seconds on an idle machine and timed out at 5 seconds on a busy one
- [x] #3 `bun test packages/engine/test/gate` passes
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M5CWE5378MZ3QE5K80MNMSEA (Haiku, 8 turns, about $0.01, under a minute) reported done, In Review, with no denied call and no write outside the References. As the maintainer answered (2026-10-20, 30 s limit for this test): the story.gate test in story-gate.test.ts passes 30000 ms as it()'s third argument (0017, Timeouts) and stays local; the file comment says why (real git and the pinned Backlog CLI several times, about 4 s idle, timed out at 5 s busy). Most of the diff is oxfmt re-indentation. Fixed on top after review: the comment names the story.gate test instead of 'the first test'. Verify outside the sandbox on the finish worktree with origin/main merged in: exit 0, 4059 tests; DIPO_TEST_CI=1 gate tests pass (117).
<!-- SECTION:NOTES:END -->
