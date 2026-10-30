---
id: DIPO-378
title: Reap orphaned processes in every box
status: Done
assignee: []
created_date: '2026-10-29 12:45'
updated_date: '2026-10-30 17:16'
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
- [x] #1 Every box dipo starts (run, fill, build, Safe-Chain, review and test boxes) is created with `--init`, added once in `createArgs` (box/apple-args.ts), and the header rule list there names it
- [x] #2 The box argument list gains nothing else: no new mount, network, capability or user, shown by the existing argument tests; the firewall and the box user are unchanged, and the keepalive command is unchanged and still keeps the box running
- [x] #3 A test with a real box (DIPO_TEST_BOX=1) starts an orphan that exits and shows it is reaped, not left as a zombie
- [x] #4 The zombie-aware checks in testkit running.ts are removed, or the PR says why a case still needs them
- [x] #5 What the old start caught, each with a test: the keepalive keeps the box running until dipo stops it (CONTAINED_KEEPALIVE for run, fill, Safe-Chain, review and test boxes; the image's own tail, BOX_KEEPALIVE, for the build box, which has no mounted tools); the box user holds no capability and the box keeps only NET_ADMIN; the box's mounts are as before. Under --init each still holds, shown by the argument tests and by a real-box check of mounts and capabilities for a run box and a build box
- [x] #6 Bypass forms are tested in a real box as the box user after the firewall is set through the full-privilege exec: kill -9 of PID 1 and of the keepalive either fails or stops the box, and the nft rule is still listed afterwards; a process that double-forks to escape the reaper is still reaped; and --init cannot be dropped or replaced, because the argument list is fixed in createArgs and not taken from office config
- [x] #7 Fail-closed against the real path: a real box created with --init, with its firewall set as dipo sets it, still refuses what the firewall refuses (the Mac on all interfaces and loopback, the local network, a registry straight out), for both the run box and the build box path
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Every box dipo makes starts with Apple container's --init, added once in createArgs: PID 1 is /.cz-init with the keepalive as its child, and it reaps orphans (a double fork, setsid and twenty at once, on a run box and a build box). The argument list gains only --init; the box gains one read-only file mount, /.cz-init, from the VM's own root (nothing of the Mac), which the box cannot write or unmount, noted against criterion 2 with the maintainer's agreement. What the old start caught (the keepalive, the box user without capabilities, NET_ADMIN only for root, the mounts) is pinned and holds; as the box user every form of killing PID 1 or the keepalive fails and the firewall stays; --init cannot be dropped through inputs; the firewall refuses as before on the run box and the build box. The zombie-aware test checks stay for now because boxes of older pinned binaries still run verify (criterion 4's PR clause); a follow-up removes them. ADR 0008 names the init, with one Replaced line, approved by the maintainer. The escape probe passed.
<!-- SECTION:FINAL_SUMMARY:END -->
