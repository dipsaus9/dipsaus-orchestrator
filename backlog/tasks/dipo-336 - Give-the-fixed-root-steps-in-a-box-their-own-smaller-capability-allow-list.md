---
id: DIPO-336
title: Give the fixed root steps in a box their own smaller capability allow list
status: Refined
assignee: []
created_date: '2026-10-23 16:20'
labels: []
milestone: m-2
dependencies: []
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
Follow-up of the DIPO-334 review. Build boxes and the fixed root steps of other boxes share one root allow list; the fixed steps outside a build box (mkdir, chown -R -h, rm -rf of a stage, chmod of dipo-part) need only chown, dac_override and fowner.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Root steps outside a build box run with only the capabilities they need, and the build box keeps its own list
- [ ] #2 Tests pin both lists
<!-- AC:END -->
