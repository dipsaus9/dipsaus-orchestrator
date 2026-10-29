---
id: DIPO-380
title: Answer dipo desk while an office is loading
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
  - packages/engine/src/reads/
  - packages/engine/src/office/
  - packages/daemon/src/
priority: medium
type: bug
ordinal: 360000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo desk` right after `dipo office open` answers at once, with the loading office shown as loading, instead of timing out.

Found on 2026-10-29 during the cutover (G7): `dipo desk` right after `dipo office open` of this repository timed out with 'the daemon did not answer within 10 s' while the office loaded (the leftover sweep, the image check), and worked a minute later. 0007.

```dipo
branch: "DIPO-380/desk-answers-while-office-loads"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) desk answers with an office marked loading while its load is held"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The desk read does not wait for an office's load; an office that is still loading appears on the desk as loading
- [ ] #2 A test opens an office whose load is held, and `desk` answers within the read deadline with that office marked loading
<!-- AC:END -->
