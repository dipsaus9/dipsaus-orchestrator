---
id: DIPO-129
title: Wire the run services in one engine function for the daemon and the tests
status: Refined
assignee: []
created_date: '2026-10-16 13:06'
updated_date: '2026-10-17 16:45'
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
- [ ] #1 One engine function (for example composeRuns(ports)) builds the launcher, resumer, control, outcomes and re-attach from injected ports; daemon/src/runs.ts and engine/test/run/run-office.ts both use it
- [ ] #2 Every difference found between the two copies is listed in the PR, and each is resolved to the daemon's behaviour or explained
- [ ] #3 The full suite and the CI-only run and daemon tests pass, and the lint exception lists of DIPO-127 (when merged) do not grow
<!-- AC:END -->
