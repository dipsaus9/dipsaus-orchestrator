---
id: DIPO-233
title: Keep the Backlog CLI gate test from timing out on a busy machine
status: To Do
assignee: []
created_date: '2026-10-20 10:40'
updated_date: '2026-10-20 10:40'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/test/gate/story-gate.test.ts
  - packages/engine/test/gate/story-gate.ci.test.ts
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
    status: "open"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) bun test packages/engine/test/gate passes; with (a) the story.gate test passes its limit of 30000 ms as the third argument of it(), with (b) story-gate.test.ts is gone and the moved test registers only when DIPO_TEST_CI is 1"
    - kind: "automated"
      check: "(integration, CI only with answer b) CI runs story-gate.ci.test.ts with DIPO_TEST_CI=1 and the moved test passes there; the worker writes it and does not run it in its sandbox"
    - kind: "automated"
      check: "(unit) the file comments of story-gate.test.ts and story-gate.ci.test.ts name where the test runs and why"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The test "story.gate returns every failure of a failing story and stores nothing; unreadable inputs answer contract codes" no longer runs under Bun's default limit of 5000 ms: as the unknown's answer picks, it sets a limit of 30000 ms with the third argument of it() in packages/engine/test/gate/story-gate.test.ts, or it moves unchanged into packages/engine/test/gate/story-gate.ci.test.ts inside its DIPO_TEST_CI guard and story-gate.test.ts is removed
- [ ] #2 The file comments of story-gate.test.ts (while it exists) and story-gate.ci.test.ts say where the test runs and why: it runs real git and the pinned Backlog CLI several times, took about 4 seconds on an idle machine and timed out at 5 seconds on a busy one
- [ ] #3 `bun test packages/engine/test/gate` passes; with answer (b) the moved test registers only when DIPO_TEST_CI is 1, as the other tests of story-gate.ci.test.ts do, and CI runs it
<!-- AC:END -->
