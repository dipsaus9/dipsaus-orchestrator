---
id: DIPO-129
title: Wire the run services in one engine function for the daemon and the tests
status: Done
assignee: []
created_date: '2026-10-16 13:06'
updated_date: '2026-10-17 20:11'
labels:
  - 'tier:M'
milestone: m-1
dependencies:
  - DIPO-126
references:
  - packages/engine/src/run
  - packages/engine/src/index.ts
  - packages/engine/test/run
  - packages/daemon/src/runs.ts
  - packages/daemon/test
  - .oxlintrc.json
priority: medium
type: task
ordinal: 119000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the daemon and the engine's run tests build the run services through one engine function, so the tests exercise the same wiring the daemon runs.

Context: the run wiring exists twice, in packages/daemon/src/runs.ts and in packages/engine/test/run/run-office.ts (about 430 lines), and the copies already differ. A fix to one does not reach the other, so tests can pass against wiring the daemon does not use. This comes before the run code split (DIPO-128), so the split updates one wiring site instead of two; it follows the intent helper (DIPO-126), which changes the same constructors. Found by the 2026-10-16 milestone review, section 1c CC9.

```dipo
branch: "DIPO-129/one-run-services-wiring"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the daemon and the engine run tests build the run services through the same engine function"
    - kind: "automated"
      check: "(ci) the full suite and the CI-only run and daemon tests pass"
    - kind: "automated"
      check: "(lint) the DIPO-127 lint exception lists, when merged, do not grow"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 One engine function (for example composeRuns(ports)) builds the launcher, resumer, control, outcomes and re-attach from injected ports; daemon/src/runs.ts and engine/test/run/run-office.ts both use it
- [x] #2 Every difference found between the two copies is listed in the PR, and each is resolved to the daemon's behaviour or explained
- [x] #3 The full suite and the CI-only run and daemon tests pass, and the lint exception lists of DIPO-127 (when merged) do not grow
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Run wirings still built by hand in tests, for DIPO-128 to move onto composeRuns or keep as unit seams: packages/engine/test/run/reattach.test.ts:153-190, reattach.ci.test.ts:65-89 and 303, outcomes.test.ts:117/133, plan-limit.test.ts:133/149, park-resume.test.ts:160/298/354, verify-commit.test.ts:257/561, hooks/park-answers.test.ts:113, run/start.test.ts:256, ingest/command-bodies.test.ts:147. park-resume.ci.test.ts and temp-dirs.ci.test.ts also build their own PermissionAsks for work.answer next to the composed one.

Delivered by dipo (M1a run 3, run_01M55K7SYYQ6ADG1J90PYK1K10, Sonnet medium), parked blocked after 40 turns and about $0.80: its sandbox cannot run the CI-only run and daemon tests (EPERM on ~/.claude/plugins, DIPO-176), so criterion 3 stayed unconfirmed and the work stayed uncommitted in dipo's worktree. M0 cannot answer a parked question and resume (DIPO-155, DIPO-159).

Maintainer side: the worker's work was copied unchanged to DIPO-129/one-run-services-wiring-finish; outside the sandbox verify and DIPO_TEST_CI run+daemon tests passed. Review blocked on an incomplete differences list (7 missing); fixed on top: the test wiring now gets the daemon's permission wait and nudges, PlanLimits moved into composeRuns, composeRuns split under DIPO-127's limits, behavioural compose tests. Final: verify 3154 pass, CI run+daemon 458 pass; daemon behaviour checked unchanged argument by argument.
<!-- SECTION:NOTES:END -->
