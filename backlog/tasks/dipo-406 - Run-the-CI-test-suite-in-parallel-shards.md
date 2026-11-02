---
id: DIPO-406
title: Run the CI test suite in parallel shards
status: Done
assignee: []
created_date: '2026-10-31 08:39'
updated_date: '2026-11-01 13:31'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies: []
references:
  - .github/workflows/ci.yml
  - scripts/
  - package.json
priority: high
type: chore
ordinal: 384000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: CI's verify jobs finish in about a third of their time, so a dipo story waits about 6 minutes for CI instead of about 16.

Measured 2026-10-31 (run 41183227764): verify-macos took 782 s, of which bun test took 768 s, running 530 files one after another (5,985 tests); verify on Linux took 638 s. The slowest file, review-loop.ci.test.ts, took 150 s; the rest is a long tail of real-process and real-git tests. Split bun test into parallel jobs per OS by recorded file time, keeping the required check ci-ok meaning the same. It changes .github/, so the maintainer merges it (Code Owners). 0016, 0004.

```dipo
branch: "DIPO-406/ci-test-shards"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(ci) the verify jobs run bun test in parallel shards that together run every test file exactly once, and ci-ok fails when any shard fails"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A new checks job per OS (or one, if both OS give the same result) runs format, lint and typecheck once; the verify and verify-macos jobs become matrix jobs of at least three shards that run only bun test on a list of files each, with the job ids verify and verify-macos kept so ci-ok's needs.<id>.result is failure or cancelled when any shard fails
- [x] #2 Each shard's file list comes from a timing file in the repository and a script that splits by it; a test file missing from the timing file goes to the shard with the least time; every file runs in exactly one shard, checked by a step that fails when a file is in none or two; the timing file is refreshed by a script the PR documents
- [x] #3 Every new job (the checks job and the coverage check) is added to ci-ok's needs, to the light-path skip list and to scripts/ci-light-path.test.ts, each with needs: changes and the backlog-only skip; ci-light-path.test.ts gains cases for a failed shard, a cancelled shard and the light path
- [x] #4 Each shard keeps DIPO_TEST_CI=1 and its own short DIPO_TMP; the required checks stay exactly ci-ok and pr-title, so no repository setting changes; macOS still runs on every heavy-path PR
- [x] #5 Wall time, as the median of three runs on the PR: verify-macos at most about 6 minutes, verify on Linux at most about 5, recorded in the PR; bun run verify locally is unchanged (one run, all files)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
CI runs bun test in parallel shards: verify (Linux, 3 shards) and verify-macos (macOS, 4 shards) keep their job ids as matrices that run only bun test on a file list split by scripts/test-timings.json (scripts/test-shards.ts); a checks job runs format, lint and typecheck once; a test-shards job fails when a file is in no shard or two. Each shard has DIPO_TEST_CI=1 and its own mktemp DIPO_TMP and runs through bun run test. ci-ok needs every new job, the light path is unchanged, and the required checks stay ci-ok and pr-title. Median of three runs: verify-macos 858 s to 294 s, verify 655 s to 234 s, the whole run 14.7 min to 5.7 min. Local bun run verify is unchanged.
<!-- SECTION:FINAL_SUMMARY:END -->
