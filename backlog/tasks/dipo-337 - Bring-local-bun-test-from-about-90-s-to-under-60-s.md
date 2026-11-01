---
id: DIPO-337
title: Run local bun test in parallel shards to get it under 60 s
status: Refined
assignee: []
created_date: '2026-10-24 09:32'
updated_date: '2026-11-01 13:30'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-351
  - DIPO-406
references:
  - scripts/test.ts
  - scripts/test-shards.ts
  - scripts/test-timings.json
  - package.json
  - docs/decisions/0017-testing-strategy-and-configuration.md
priority: medium
type: chore
ordinal: 318000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `bun run test` (and so `bun run verify`) takes under 60 s on the maintainer's Mac, and less in a worker's box, so every story's verify and every builder wait gets shorter.

Measured 2026-11-01 on main 5c81b13f: `bun test` ran 5,787 tests in 535 files in 147 s wall on the Mac (a dipo run was busy beside it); a dipo worker's box took 101.6 s (DIPO-410). Bun runs the files one after another. DIPO-406 (#505) adds `scripts/test-timings.json` and `scripts/test-shards.ts`, which split the files into shards of about equal time and check that each file is in exactly one. This story reuses that split locally: `scripts/test.ts` starts several `bun test` processes at once, one per shard, each with its own short DIPO_TMP, and fails when any fails, as CI's shards do. One split for CI and local (0001). The held comment of 2026-10-24 is done: the prune has ended.

Earlier follow-up text (DIPO-225): fast local versions of the CI-only tests index-notify, clean-folder and park-commit, and packages/daemon/src/hook.test.ts (5.4 s). These are optional here; the parallel shards are the main lever. 0017, 0016, 0001.

```dipo
branch: "DIPO-337/local-test-shards"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(scripts) bun run test runs every test file exactly once in parallel shards and fails when any shard fails"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `bun run test` runs the test files in parallel shards (as many as the machine's cores allow, at least 2) chosen by the same split as CI's shards, each with its own short DIPO_TMP under the caller's DIPO_TMP, and exits non-zero when any shard fails, shown by a test with a failing file in one shard
- [ ] #2 Every test file runs exactly once in a local run, shown by the same coverage check CI's shards use; `bun test <file>` and `bun run test <file>` for one file still run just that file
- [ ] #3 `bun run verify` takes under 60 s on the maintainer's Mac with nothing else running, measured three times before and after and recorded in the PR; the output still names each failing test
- [ ] #4 In CI (`DIPO_TEST_CI=1`) each shard job still runs its own file list once, unchanged; no test is removed, skipped or moved to CI-only by this story
<!-- AC:END -->

## Comments

<!-- COMMENTS:BEGIN -->
created: 2026-10-25 09:55
---
Held on 2026-10-24 until the prune toward the simplified architecture ends (DIPO-351 and Track 2). The prune removes code and tests, so the test time is measured again after it.
---
<!-- COMMENTS:END -->
