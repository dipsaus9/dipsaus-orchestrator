---
id: DIPO-378
title: Reap orphaned processes in every box
status: Refined
assignee: []
created_date: '2026-10-29 12:45'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-351
references:
  - packages/engine/src/box/apple-args.ts
  - packages/engine/src/box/firewall.ts
  - packages/engine/src/box/safe-chain.ts
  - packages/testkit/src/running.ts
  - packages/engine/test/box/
priority: medium
type: bug
ordinal: 358000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: orphaned processes in a long-lived box are reaped, so zombies no longer pile up during a run.

Found on 2026-10-29 by DIPO-372: a box's PID 1 is the keepalive `tail -f /dev/null` (box/apple-args.ts BOX_KEEPALIVE, box/firewall.ts CONTAINED_KEEPALIVE, box/safe-chain.ts), which never calls wait(), so every orphan becomes a zombie that stays until the box stops. DIPO-372 made the process tests zombie-aware (testkit running.ts) instead. Apple container has `container run --init`, an init process that forwards signals and reaps. 0008. This removes the zombie-aware workaround in testkit running.ts if the reaping makes it unneeded.

```dipo
branch: "DIPO-378/box-init-reaps-zombies"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) every box argument list includes the init flag"
    - kind: "automated"
      check: "(box) an orphan that exits in a real box is reaped"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every box dipo starts (run, fill, build, Safe-Chain, review and test boxes) runs with an init process that reaps orphans, set in one place in the box argument builder
- [ ] #2 A test with a real box (DIPO_TEST_BOX=1) starts an orphan that exits and shows it is reaped, not left as a zombie
- [ ] #3 The keepalive, the box firewall and the box user are unchanged, shown by the existing box tests
<!-- AC:END -->
