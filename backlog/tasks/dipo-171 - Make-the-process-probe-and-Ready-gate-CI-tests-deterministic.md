---
id: DIPO-171
title: Make the process-probe and Ready gate CI tests deterministic
status: In Progress
assignee: []
created_date: '2026-10-17 16:59'
updated_date: '2026-10-17 22:51'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/test/platform/process.test.ts
  - test/lifecycle-parity/
  - packages/engine/test/gate/story-gate.ci.test.ts
  - packages/engine/test/gate/gated-office.ts
priority: high
type: bug
ordinal: 160000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the two tests that failed at random in CI on PRs #154, #159 and #162 fail only when the code under test is wrong, so a required check no longer needs a rerun for them.

Context: findings 4, 14 and 19 of the DIPO-115 cutover. "system probe > reads a child's full command line" (packages/engine/test/platform/process.test.ts) failed on Linux in CI on PR #154 (run 38915640940, attempt 1) and on PR #162 (run 38954236450, attempt 1). The #162 log shows the probe read `command: ""` for the pid of `/bin/sleep 30`: the test reads /proc/<pid>/cmdline right after Bun.spawn returns, before the child has exec'd, and Linux shows an empty cmdline then. The same spawn-then-read pattern is in "reads the same as /bin/ps on macOS" in the same file and in "probe this process and a child the same way" (test/lifecycle-parity/lifecycle-parity.test.ts). One way: the child is a program that writes a ready line itself, and the test reads the probe after that line arrives.

"the Ready gate on the Backlog CLI > a pickup-mode evaluation stores one decision with every rule result and the hash" (packages/engine/test/gate/story-gate.ci.test.ts) hit bun's default 5000 ms timeout on PR #159 (run 38942474480, attempt 1); the rerun passed in 3853 ms. Its time goes to real Backlog CLI and git subprocesses (milestone add, task edit, publish, fetch, index). The two tests cost a rerun on 3 of the last 4 PRs, and from M1a dipo's own merges wait on these checks. A retry is not a fix. DIPO-121 handles the same timeout pattern for packages/engine/test/stories/index.ci.test.ts.

```dipo
branch: "DIPO-171/deterministic-probe-and-gate-tests"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the probe tests read the command line of a child that has written its ready line, on Linux and macOS"
    - kind: "automated"
      check: "(ci) the pickup-mode gate test passes under half its timeout in 5 CI runs"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every test in process.test.ts and lifecycle-parity.test.ts that reads a child's command line through the probe reads it only after the child has written a ready line from its own program; no sleep, poll loop or retry decides the result
- [ ] #2 The pickup-mode Ready gate test is split, makes fewer subprocess calls, or sets a per-test timeout from a measured CI runtime stated in a comment; the slowest of at least 5 CI runs is under half its timeout, stated in the PR
- [ ] #3 Each changed test still fails when the code under test is broken: the PR states, per test, the change to the code under test that was tried and the failure it gave
- [ ] #4 The changed probe tests pass 20 runs in a row with bun test --rerun-each 20, stated in the PR
<!-- AC:END -->
