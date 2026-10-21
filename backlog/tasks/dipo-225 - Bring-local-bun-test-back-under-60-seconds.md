---
id: DIPO-225
title: Bring local bun test back under 60 seconds
status: To Do
assignee: []
created_date: '2026-10-19 23:02'
updated_date: '2026-10-21 23:04'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies:
  - DIPO-284
  - DIPO-285
  - DIPO-287
  - DIPO-288
  - DIPO-289
  - DIPO-290
  - DIPO-291
  - DIPO-292
references:
  - packages/engine/test/
  - packages/daemon/test/
  - packages/client/test/
  - test/
  - package.json
priority: medium
type: chore
ordinal: 225000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: local `bun test` (without DIPO_TEST_CI) runs in under 60 s again, as CLAUDE.md and 0017 section 1 set, and every test it no longer runs still runs in CI.

Context: on the maintainer's machine on 2026-10-20 a local `bun run verify` took 96 to 110 s, of which `bun test` took 97 to 107 s. 0017 section 1: a test goes CI only when it is slow (the budget is the whole local bun test under about 60 seconds), needs timing-sensitive process lifecycles, or needs a platform matrix; correctness rules never go CI only. CI sets DIPO_TEST_CI=1 and runs the same `bun run verify`. Bun 1.4.2 writes per-file durations in ms to a JSON file with `bun test --timings=<file> --update-timings`, which a worker can run in its sandbox. Bun 1.4.2 also has `--parallel`, which implies `--isolate`; bunfig.toml sets randomize = true and a preload. Which tests change cannot be settled from the code before the measurement.

```dipo
branch: "DIPO-225/local-bun-test-under-60s"
unknowns:
  - q: "How is the 60 s reached? (a) Move the slowest files that start real processes or real git repositories to *.ci.test.ts, keeping a local unit test for each rule they check (0017 allows slow tests CI only). (b) Run local bun test with --parallel, which changes the test script that verify, workers and CI share and needs every test to keep its own temp paths and ports. (c) Speed up the slowest files (shared fixture repositories, fewer process spawns) and move only what stays slow. Recommended: (a), with (c) for a file whose time comes from a fixture it can share."
    status: "open"
test_plan:
  entries:
    - kind: "automated"
      check: "(command) bun test --timings=<file under DIPO_TMP> --update-timings before and after the change; the evidence lists the 15 slowest files and the sum of all durations for both runs"
    - kind: "automated"
      check: "(command) after the change the sum of the per-file durations is under 60,000 ms and bun run verify passes"
    - kind: "automated"
      check: "(unit) each file that moved is named *.ci.test.ts and registers its describe only when DIPO_TEST_CI is 1, with its test names unchanged"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The worker measures local bun test before and after its change with `bun test --timings=<file under DIPO_TMP> --update-timings`, and its evidence holds the 15 slowest files with their durations and the sum of all durations for both runs
- [ ] #2 After the change the sum of the per-file durations of local bun test, measured that way, is under 60,000 ms, and bun run verify passes
- [ ] #3 Every test the local run no longer runs is in a *.ci.test.ts file that registers its describe only when DIPO_TEST_CI is 1 (0017 section 1), with its test name and assertions unchanged
<!-- AC:END -->
