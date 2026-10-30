---
id: DIPO-396
title: Attribute each Safe-Chain refusal to the box that made the request
status: Refined
assignee: []
created_date: '2026-10-30 16:01'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-376
references:
  - packages/engine/src/box/safe-chain-box.ts
  - packages/engine/src/box/safe-chain.ts
  - packages/engine/src/box/workers.ts
  - packages/engine/src/box/web-proxy.ts
priority: medium
type: bug
ordinal: 374000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a Safe-Chain refusal is stored only on the run whose box made the refused request, so overlapping sessions of different runs and offices never see each other's refusals.

Gap G12, found by the review of PR #463 (DIPO-376): one BoxWorkers and one web route serve every loaded office (create/runs.ts, box/workers.ts), and Safe-Chain's log does not say which box asked, so a refusal is stored on every run whose session was open at the time, across offices too (0007 keeps state per office). Impact is low (public package names, extra refused lines), but it is wrong data in a run row. Fix idea: the web proxy knows the client box of each tunnel; pass that through to Safe-Chain (a port per box, or a header or log field Safe-Chain records), or attribute in the web proxy instead of reading Safe-Chain's log. 0008, 0007.

```dipo
branch: "DIPO-396/safe-chain-refusal-per-box"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(box) two runs with overlapping sessions: each run row holds only its own box's refusals"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Each stored refusal names the run whose box made the refused request; a refusal is never stored on a run whose box did not make it
- [ ] #2 A real-box test (DIPO_TEST_BOX=1) with two boxes of two runs whose sessions overlap, each installing a different refused package, shows each run row holds only its own refusal
- [ ] #3 A refusal whose box cannot be told is stored as unknown on the runs that were open, never as a refusal of one of them, and the PR says how often that can happen
- [ ] #4 The escape probe runs again if the change touches the Safe-Chain image or the box network (0008)
<!-- AC:END -->
