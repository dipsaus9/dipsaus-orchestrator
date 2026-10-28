---
id: DIPO-336
title: Give the fixed root steps in a box their own smaller capability allow list
status: Refined
assignee: []
created_date: '2026-10-23 16:20'
updated_date: '2026-10-28 15:07'
labels:
  - 'slice:prune'
  - 'track:2'
  - 'tier:S'
milestone: m-1
dependencies:
  - DIPO-351
references:
  - packages/engine/src/box/firewall.ts
  - packages/engine/src/box/user.ts
  - packages/engine/test/box/
priority: low
type: task
ordinal: 317000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the fixed root steps outside a build box run with only chown, dac_override and fowner, while a build box keeps its own capability list.

Follow-up of the DIPO-334 review. Build boxes and the fixed root steps of other boxes share one root allow list; the fixed steps outside a build box (mkdir, chown -R -h, rm -rf of a stage, chmod of dipo-part) need only chown, dac_override and fowner.

This story changes a capability allow list, so its criteria name what the steps still need, the bypass forms and a fail-closed test against the real path (CLAUDE.md, R30).

```dipo
branch: "DIPO-336/root-step-capabilities"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(box) each fixed root step outside a build box runs with chown, dac_override and fowner only, and a build box keeps its own list"
    - kind: "automated"
      check: "(box) a fixed step that needs a capability outside its list fails, and the box user never gains a capability"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Root steps outside a build box run with only chown, dac_override and fowner, and the build box keeps its own list
- [ ] #2 Tests pin the exact capability string of both lists, and none of dac_read_search, fsetid, setuid, setgid, kill, sys_chroot or audit_write is in the fixed-step list
- [ ] #3 Each fixed root step still does its job with the smaller list, each with a test in a real box (a *.box.test.ts): mkdir, chown -R -h, rm -rf of a stage and chmod of dipo-part
- [ ] #4 The bypass forms are tested: a command outside the fixed list asked for as root is refused, a step's arguments cannot add a capability, and a non-build box never gets the build box's list
- [ ] #5 A fail-closed test against the real path: in a real box, a fixed root step that needs setuid fails, and no root step runs with the old shared list
<!-- AC:END -->
