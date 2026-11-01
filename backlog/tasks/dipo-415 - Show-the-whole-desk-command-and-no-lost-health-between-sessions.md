---
id: DIPO-415
title: Show the whole desk command and no lost health between sessions
status: Refined
assignee: []
created_date: '2026-11-01 15:39'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/cli/src/desk-command.ts
  - packages/cli/src/watch-command.ts
  - packages/client/src/health-text.ts
  - packages/engine/src/run/
priority: low
type: bug
ordinal: 393000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: what the desk and `dipo watch` show can be acted on as read: commands appear whole, and a run moving from developer to reviewer does not look lost.

Found in the M1 hand-test wave of 2026-11-01 on the scratch office (binary 9c7d41238fbc). The desk detail of a merge gate was cut mid-command: "or reject with `dipo rejec…`" (the text comes from packages/engine/src/run-state/gates.ts; the cut from the desk's line width, packages/cli/src/desk-command.ts). `dipo watch` briefly showed "health LOST !!" between the developer session's end and the reviewer's start (health text in packages/client/src/health-text.ts). 0009.

```dipo
branch: "DIPO-415/desk-and-watch-text"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(cli) the desk detail never cuts a command in half, and watch shows no LOST health between the developer's end and the reviewer's start"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A desk detail longer than the line wraps or ends before a command; it never cuts inside a backticked command, shown by a test with the merge-gate text
- [ ] #2 Between a developer session's end and the reviewer session's start, a run's health is not shown as lost, shown by a test
<!-- AC:END -->
