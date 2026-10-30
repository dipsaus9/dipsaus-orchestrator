---
id: DIPO-376
title: Name Safe-Chain when it refuses a package in a box
status: Parked
assignee: []
created_date: '2026-10-29 09:29'
updated_date: '2026-10-30 09:34'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-351
references:
  - packages/engine/src/box/safe-chain.ts
  - packages/engine/src/box/
priority: medium
type: bug
ordinal: 356000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: when Safe-Chain refuses a package a box installs, the worker and the reviewer see that Safe-Chain refused it and why, not only a bare HTTP 403 from the registry.

Found on 2026-10-29 by the scratch smoke run of TASK-5: `bun add safe-chain-test` failed with `error: GET https://registry.npmjs.org/safe-chain-test/-/safe-chain-test-0.0.1-security.tgz - 403`, and neither the worker nor the reviewer could tell it was Safe-Chain, so the reviewer left two criteria to the maintainer. 0008 (the Safe-Chain box, DIPO-343).

```dipo
branch: "DIPO-376/name-safe-chain-refusals"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a Safe-Chain refusal reaches the worker's context and the review context with Safe-Chain named"
park:
  reason: "ambiguous-spec"
  from: "In Progress"
  note: "Where should the run keep Safe-Chain's refusals so the worker's next turn and the reviewer see this run's refusals only? Option A: read the two Safe-Chain logs from the box live when the next turn or review is built, and store a per-run line offset on the run (needs a migration and a route reader wired from BoxWorkers into run/). Option B: have the box workers store the refusals on the run when a session ends (a new runs column, also a migration). I recommend A, since the logs are the only copy of the refusal and the box lives with the route. Which do you want, and may I widen the work to db/, run/ and box/workers.ts?"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A package Safe-Chain refuses gives an error the install command prints that names Safe-Chain and the reason, or dipo adds that fact to the worker's next turn from the Safe-Chain box's log
- [ ] #2 The reviewer's context names each refusal of the run, with a test
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parked 2026-10-30 09:34 UTC: ambiguous-spec
- Detail: Where should the run keep Safe-Chain's refusals so the worker's next turn and the reviewer see this run's refusals only? Option A: read the two Safe-Chain logs from the box live when the next turn or…
- Run: run_01M6629HFME12CQFGW513K46VD
- Criteria met: 0 of 2 (as the worker reported them)
- Loops: 0 of 3; CI attempts: 0 of 2
- Review rounds: 0, failed 0 of 3
- Budget used: 143,395 of 300,000 tokens; 56 of 90 turns; 5 of 45 minutes
- Last good commit: d1b5c174c3d81f103b722a47207e90e0e07e914a
<!-- SECTION:NOTES:END -->
