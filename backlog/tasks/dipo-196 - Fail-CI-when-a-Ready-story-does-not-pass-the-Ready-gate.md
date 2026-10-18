---
id: DIPO-196
title: Fail CI when a Ready story does not pass the Ready gate
status: Done
assignee: []
created_date: '2026-10-17 23:16'
updated_date: '2026-10-18 09:37'
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

Context: DIPO-135 was set Ready in #176 although its manual test-plan entry had no expect. Rule R20 (packages/engine/src/gate/rules.ts) refused it only at `dipo run --dry-run`. Nobody ran the gate on the Ready PR; `dipo gate` then timed out on this repository, which DIPO-180 fixed. The gate itself needs no daemon: evaluateGate (packages/engine/src/gate/evaluate.ts) is pure, readGateInput (packages/engine/src/gate/store/read.ts) reads one story's input through the Backlog CLI, and gateConfigOf (packages/engine/src/gate/store/feature.ts) builds the gate config from the office config that loadOfficeConfig (packages/engine/src/config/load.ts) reads from .dipo/office.yaml. backlog.md 1.53.0 is a root devDependency, so CI has the CLI. Since DIPO-180 (Done, #197) readGateInput takes an optional `others: readonly GateTask[]`, which the daemon fills from the stories index mirror; without it, it views every task. gateTaskFromView (packages/engine/src/gate/input.ts) maps a task view to a GateTask. The script has no daemon and no mirror, so it views every other task once for all Ready stories and maps the views to GateTask values. The part of readGateInput that builds a GateInput from the story view, its subtasks, the other tasks as GateTask values, the milestones and the GateConfig becomes one exported function in read.ts, used by readGateInput and by the script, and the script holds no copy of it.

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
- [x] #1 packages/engine/src/gate/store/read.ts exports one function that builds a GateInput from a story view, its subtasks, the other tasks as GateTask values, the milestones and a GateConfig, and readGateInput uses it; scripts/check-ready-gate.ts exports a function that, for a repository path and a Backlog CLI, loads the office config with loadOfficeConfig, lists the tasks, reads the other tasks' views once for all Ready stories, builds each Ready story's input with that shared function, evaluates it with evaluateGate in mode pickup (R01b and the shared rules R02 to R26, the ready-mode rules with status Ready in place of Refined), and returns each failure as the gate's ready <ID> failed <rule> message
- [x] #2 Run as bun scripts/check-ready-gate.ts it prints every failure and exits 1 when there is one, and otherwise prints how many Ready stories it checked and exits 0
- [x] #3 A unit test next to the script, with a fake Backlog CLI over a fixture backlog, shows a Ready story whose manual test-plan entry has no expect fails R20, a clean Ready story passes, a Refined story with the same fault is not checked, and each other task is viewed once
- [x] #4 test/ready-gate/ready-gate.ci.test.ts registers only when DIPO_TEST_CI=1, runs the check on this repository with the root devDependency's Backlog CLI, fails with the failure messages when any Ready story fails, and has a timeout sized for the read, stated in a comment with the measured time; .github/workflows/ci.yml is not changed
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M574P2PEE5YCJ0HW8V6F6EYR (Haiku low, 38 turns, about $0.05, 5 min) reported done, all four criteria, In Review on DIPO-196/ci-ready-gate-check, with no denied call. Verify outside the sandbox on DIPO-196/ci-ready-gate-check-finish (origin/main merged in): 3271 pass, 2 skip, 0 fail. DIPO_TEST_CI=1 bun test test/ready-gate/: 1 pass in 12.9 s. bun scripts/check-ready-gate.ts on this repository: "Ready gate ok: 1 Ready stories checked" in 13 s.

Manual check (maintainer side): in the finish worktree DIPO-120 (no field block) was set Ready through the CLI; the script printed its R15, R18 and R20 failures in the gate's own form and exited 1; the task file was then restored with git checkout.

Review passed. Criterion 1 said mode ready; the script evaluates in pickup mode, which runs the same shared rules with R01b in place of R01a (ready mode would fail every Ready story at R01a). Criterion 1 now says so.
<!-- SECTION:NOTES:END -->
