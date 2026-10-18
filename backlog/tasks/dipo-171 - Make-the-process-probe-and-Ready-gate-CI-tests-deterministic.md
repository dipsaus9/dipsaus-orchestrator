---
id: DIPO-171
title: Make the process-probe and Ready gate CI tests deterministic
status: Done
assignee: []
created_date: '2026-10-17 16:59'
updated_date: '2026-10-17 23:43'
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
- [x] #1 Every test in process.test.ts and lifecycle-parity.test.ts that reads a child's command line through the probe reads it only after the child has written a ready line from its own program; no sleep, poll loop or retry decides the result
- [x] #2 The pickup-mode Ready gate test is split, makes fewer subprocess calls, or sets a per-test timeout from a measured CI runtime stated in a comment; the slowest of at least 5 CI runs is under half its timeout, stated in the PR
- [x] #3 Each changed test still fails when the code under test is broken: the PR states, per test, the change to the code under test that was tried and the failure it gave
- [x] #4 The changed probe tests pass 20 runs in a row with bun test --rerun-each 20, stated in the PR
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M560YT04A2WVEQ62W3AZNP1S (Haiku low, 25 turns, about $0.03, 2 min) wrote the change, then parked blocked to ask about the 5-CI-run measurement of criterion 2 (a maintainer step). Its uncommitted work was copied to DIPO-171/deterministic-probe-and-gate-tests-finish.

Criterion 1: process.test.ts spawnReady() spawns `/bin/sh -c 'echo ready; read line'` and returns only after the ready line; 'reads a child's full command line', the macOS ps comparison and lifecycle-parity 'probe this process and a child the same way' use it. withZombie() keeps its poll loop for zombie state; it reads no command line.

Criterion 2: the pickup-mode gate test ('a pickup-mode evaluation stores one decision with every rule result and the hash', story-gate.ci.test.ts) gets a 20 s per-test timeout. CI measurement, 5 runs of the verify job of #192 at f0a67d3 (run 39077260569, attempts 1 to 5): 4437, 4775, 4454, 4408, 3551 ms; slowest 4775 ms, under half of 20 s. The two probe tests passed in all 5 runs.

Criterion 3 (mutations, each restored): the worker's (systemProcessProbe returns command "": 4 probe tests fail; gateContentHash constant: the pickup-mode test fails). Outside the sandbox the maintainer also dropped the macOS argument read in process.ts (command falls back to (comm)): 'reads a child's full command line' and 'reads the same as /bin/ps on macOS' fail, and pass again after the restore.

Criterion 4: bun refuses --rerun-each with bunfig retry = 0, so the run used a temp bunfig without retry. Outside the sandbox: DIPO_TEST_CI=1 bun test --rerun-each 20 process.test.ts lifecycle-parity.test.ts: 660 pass, 0 fail (the macOS ps test runs here; it is skipped in the worker sandbox).

Verify outside the sandbox: 3211 pass, 2 skip, 0 fail.

Review advisories applied: the gate test's timeout comment now states the 5-run CI measurement, and spawnReady (both copies) kills and awaits its child when the ready line does not come. Not changed: withZombie's bounded poll for zombie state (it reads no live command line; a follow-up could make it fail loudly).
<!-- SECTION:NOTES:END -->
