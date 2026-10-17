---
id: DIPO-196
title: Fail CI when a Ready story does not pass the Ready gate
status: Refined
assignee: []
created_date: '2026-10-17 23:16'
updated_date: '2026-10-17 23:16'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - scripts/
  - test/
  - packages/engine/src/gate/evaluate.ts
  - packages/engine/src/gate/rules.ts
  - packages/engine/src/gate/store/read.ts
  - packages/engine/src/gate/store/feature.ts
  - packages/engine/src/config/load.ts
  - packages/engine/test/gate/
priority: medium
type: enhancement
ordinal: 185000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a PR that leaves a story Ready which fails the Ready gate fails CI with the gate's own messages, so a story like DIPO-135 cannot reach main as Ready and be refused only at `dipo run --dry-run`.

Context: DIPO-135 was set Ready in #176 although its manual test-plan entry had no expect. Rule R20 (packages/engine/src/gate/rules.ts) refused it only at `dipo run --dry-run`. Nobody ran the gate on the Ready PR, because `dipo gate` times out on this repository (DIPO-180). The gate itself needs no daemon: evaluateGate (packages/engine/src/gate/evaluate.ts) is pure, readGateInput (packages/engine/src/gate/store/read.ts) reads one story's input through the Backlog CLI, and gateConfigOf (packages/engine/src/gate/store/feature.ts) builds the gate config from the office config that loadOfficeConfig (packages/engine/src/config/load.ts) reads from .dipo/office.yaml. backlog.md 1.53.0 is a root devDependency, so CI has the CLI. readGateInput views every task for each story, so checking each Ready story through it would repeat that read; the check reads the other tasks once.

Wiring follows scripts/check-pr-title.ts, which test/backlog-pr-title/ imports. The check is a script that runs as a CI-only test (`*.ci.test.ts`, DIPO_TEST_CI=1, 0017) inside the existing verify job, so .github/workflows/ci.yml gains no job and the 0016 job table stays as it is. It is CI-only because reading every task view takes several seconds on this backlog. It checks every story whose status is Ready on the checked-out commit, not only the ones the PR changed: a PR that makes another Ready story fail, for example through a dependency, should fail too. A worker cannot change task files, so fixing a Ready story that fails on main today is a manual step, listed in the test plan.

```dipo
branch: "DIPO-196/ci-ready-gate-check"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) on a fixture backlog, a Ready story whose manual entry has no expect fails R20, a clean Ready story passes, and a Refined story with the same fault is not checked"
    - kind: "automated"
      check: "(unit) the other tasks' views are read once for all Ready stories"
    - kind: "automated"
      check: "(ci) the CI-only test runs the check on this repository and passes when every Ready story passes"
    - kind: "manual"
      check: "(local) on a scratch branch, remove the expect line of a Ready story's manual entry through the Backlog CLI, then run bun scripts/check-ready-gate.ts"
      expect: "it prints ready <ID> failed R20 for that story and exits 1"
    - kind: "manual"
      check: "(local) run bun scripts/check-ready-gate.ts on main before the PR merges"
      expect: "it exits 0 and states how many Ready stories it checked; any failing story is fixed through the Backlog CLI first"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 scripts/check-ready-gate.ts exports a function that, for a repository path and a Backlog CLI, loads the office config with loadOfficeConfig, lists the tasks, evaluates every task whose status is Ready with evaluateGate in mode ready on input built as readGateInput builds it, and returns each failure as the gate's ready <ID> failed <rule> message; the views of the other tasks are read once for all Ready stories
- [ ] #2 Run as bun scripts/check-ready-gate.ts it prints every failure and exits 1 when there is one, and otherwise prints how many Ready stories it checked and exits 0
- [ ] #3 A unit test next to the script, with a fake Backlog CLI over a fixture backlog, shows a Ready story whose manual test-plan entry has no expect fails R20, a clean Ready story passes, a Refined story with the same fault is not checked, and each other task is viewed once
- [ ] #4 test/ready-gate/ready-gate.ci.test.ts registers only when DIPO_TEST_CI=1, runs the check on this repository with the root devDependency's Backlog CLI, fails with the failure messages when any Ready story fails, and has a timeout sized for the read, stated in a comment with the measured time; .github/workflows/ci.yml is not changed
<!-- AC:END -->
