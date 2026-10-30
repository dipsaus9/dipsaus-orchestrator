---
id: DIPO-378
title: Reap orphaned processes in every box
status: Refined
assignee: []
created_date: '2026-10-29 12:45'
updated_date: '2026-10-30 08:02'
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
- [ ] #1 Every box dipo starts (run, fill, build, Safe-Chain, review and test boxes) is created with `--init`, added once in `createArgs` (box/apple-args.ts), and the header rule list there names it
- [ ] #2 The box argument list gains nothing else: no new mount, network, capability or user, shown by the existing argument tests; the firewall, the box user and the keepalive are unchanged
- [ ] #3 A test with a real box (DIPO_TEST_BOX=1) starts an orphan that exits and shows it is reaped, not left as a zombie, and that the keepalive still runs
- [ ] #4 The zombie-aware checks in testkit running.ts are removed, or the PR says why a case still needs them
- [ ] #5 What the old start caught, each with a test: the keepalive as the main process keeps the box running until dipo stops it, and the box user, the firewall rules and the dropped capabilities are as before; under --init each still holds, shown by the argument tests and by a real-box test (DIPO_TEST_BOX=1) for a run box and a build box
- [ ] #6 Bypass forms are tested in a real box as the box user: killing or signalling the init process or the keepalive does not leave the box running without its firewall, a process that double-forks to escape the reaper is still reaped, and no box command line can drop or replace --init (the argument list is fixed in createArgs, not taken from office config)
- [ ] #7 Fail-closed against the real path: a real box created with --init still refuses what its firewall refuses (the Mac on all interfaces and loopback, the local network, a registry straight out), for both the run box and the build box path
<!-- AC:END -->
