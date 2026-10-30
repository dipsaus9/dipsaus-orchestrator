---
id: DIPO-376
title: Name Safe-Chain when it refuses a package in a box
status: In Progress
assignee: []
created_date: '2026-10-29 09:29'
updated_date: '2026-10-30 09:30'
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
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A package Safe-Chain refuses gives an error the install command prints that names Safe-Chain and the reason, or dipo adds that fact to the worker's next turn from the Safe-Chain box's log
- [ ] #2 The reviewer's context names each refusal of the run, with a test
<!-- AC:END -->
