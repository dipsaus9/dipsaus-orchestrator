---
id: DIPO-225
title: Bring local bun test back under 60 seconds
status: Done
assignee: []
created_date: '2026-10-19 23:02'
updated_date: '2026-10-24 09:33'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies:
  - DIPO-284
  - DIPO-285
  - DIPO-287
  - DIPO-159
  - DIPO-290
  - DIPO-149
  - DIPO-292
  - DIPO-293
  - DIPO-294
  - DIPO-295
  - DIPO-296
  - DIPO-298
  - DIPO-299
  - DIPO-301
  - DIPO-302
  - DIPO-303
  - DIPO-152
references:
  - '- packages/engine/test/'
  - package.json
  - packages/client/test/
  - packages/daemon/test/
  - packages/daemon/test/integration/database-unavailable.ci.test.ts
  - packages/daemon/test/integration/foreground.ci.test.ts
  - packages/daemon/test/integration/foreground.test.ts
  - packages/daemon/test/unit/runtime-isolation.test.ts
  - packages/engine/test/backlog/clean-folder.ci.test.ts
  - packages/engine/test/backlog/clean-folder.test.ts
  - packages/engine/test/box/collisions.ci.test.ts
  - packages/engine/test/box/collisions.test.ts
  - packages/engine/test/box/parts.test.ts
  - packages/engine/test/commands/helpers.ts
  - packages/engine/test/gate/index-notify.ci.test.ts
  - packages/engine/test/gate/index-notify.test.ts
  - packages/engine/test/merge-slot/release-path.test.ts
  - packages/engine/test/merge-slot/story-slot.git.ci.test.ts
  - packages/engine/test/merge-slot/story-slot.git.test.ts
  - packages/engine/test/merge-slot/story-slot.test.ts
  - packages/engine/test/platform/mktemp-shim.test.ts
  - packages/engine/test/reconcile/done-elsewhere.ci.test.ts
  - packages/engine/test/reconcile/done-elsewhere.test.ts
  - packages/engine/test/reconcile/done-on-base.ci.test.ts
  - packages/engine/test/reconcile/done-on-base.test.ts
  - packages/engine/test/run/conflict-resume.ci.test.ts
  - packages/engine/test/run/conflict-resume.test.ts
  - packages/engine/test/run/conflicts.ci.test.ts
  - packages/engine/test/run/conflicts.test.ts
  - packages/engine/test/run/park-commit.ci.test.ts
  - packages/engine/test/run/park-commit.test.ts
  - packages/engine/test/run/parts-commit.ci.test.ts
  - packages/engine/test/run/parts-commit.test.ts
  - packages/engine/test/run/summary.test.ts
  - packages/engine/test/stories/index-cli.ci.test.ts
  - packages/engine/test/stories/index.test.ts
  - packages/engine/test/worktree/discard.ci.test.ts
  - packages/engine/test/worktree/discard.test.ts
  - packages/engine/test/worktree/lagging-worktree.ci.test.ts
  - packages/engine/test/worktree/lagging-worktree.test.ts
  - packages/engine/test/worktree/teardown.test.ts
  - packages/testkit/src/git.test.ts
  - packages/testkit/src/git.ts
  - packages/testkit/src/test-env.test.ts
  - packages/testkit/src/test-env.ts
  - scripts/test.ci.test.ts
  - scripts/test.test.ts
  - test/
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
    status: "resolved"
    answer: "(a) with (c) (maintainer session, 2026-10-23, a reversible choice under the speed-up process): move the slowest files that start real processes or real git repositories to *.ci.test.ts, keeping a local unit test for each rule they check, and speed up a file whose time comes from a fixture it can share."
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
- [x] #1 The worker measures local bun test before and after its change with `bun test --timings=<file under DIPO_TMP> --update-timings`, and its evidence holds the 15 slowest files with their durations and the sum of all durations for both runs
- [x] #2 Every test the local run no longer runs is in a *.ci.test.ts file that registers its describe only when DIPO_TEST_CI is 1 (0017 section 1), with its test name and assertions unchanged
- [x] #3 After the change the sum of the per-file durations of local bun test, measured that way, is under 100,000 ms (amended 2026-10-23 by the maintainer from 60,000 ms; the rest is DIPO-337), and bun run verify passes
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-23 (maintainer): measured in the maintainer session on the merged branch: 90.6 s wall, sum of per-file durations 94,520 ms (was 384,838 ms). Criterion 2 amended to under 100 s; reaching 60 s is DIPO-337 (M2).

Done 2026-10-23 (maintainer session): built outside dipo, reviewed by a separate agent (criteria met under the amended criterion 2). Local bun test from 384,838 ms to 94,520 ms (sum of per-file durations; 91 s wall). Also in this PR: DIPO-275 closed, DIPO-116 moved to M2, DIPO-337 filed for the rest to 60 s.
<!-- SECTION:NOTES:END -->
