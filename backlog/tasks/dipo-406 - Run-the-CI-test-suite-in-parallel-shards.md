---
id: DIPO-406
title: Run the CI test suite in parallel shards
status: Refined
assignee: []
created_date: '2026-10-31 08:39'
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
- [ ] #1 CI runs bun test in at least three parallel shards per OS (Linux and macOS); each shard runs a fixed list of test files chosen so the shards take about the same time, from a timing file kept in the repository and a script that splits by it
- [ ] #2 Every test file runs in exactly one shard, shown by a check in CI that fails when a file is in no shard or in two; a new test file not in the timing file still runs
- [ ] #3 Format, lint and typecheck run once per OS, not in every shard; ci-ok fails when any shard or check fails or is cancelled, and the light path for backlog-only PRs is unchanged
- [ ] #4 verify-macos wall time drops to at most about 6 minutes and verify on Linux to at most about 5, measured on the PR and recorded in it
- [ ] #5 bun run verify locally is unchanged (one run, all files)
<!-- AC:END -->
