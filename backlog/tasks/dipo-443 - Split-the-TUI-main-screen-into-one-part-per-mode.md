---
id: DIPO-443
title: Split the TUI main screen into one part per mode
status: In Review
assignee: []
created_date: '2026-11-04 12:24'
updated_date: '2026-11-06 09:10'
labels:
  - 'tier:M'
milestone: m-2
dependencies: []
references:
  - packages/tui/src/app.tsx
  - packages/tui/src/app.test.tsx
  - packages/tui/src/
priority: medium
type: chore
ordinal: 416000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want the TUI main screen split into one part per mode, so that the views that M2 and later milestones add stay easy to build and to review.

From DIPO-438 (M1 close-out review finding M1-14), split off in the planning interview 2026-11-04. Does not block M2.

packages/tui/src/app.tsx is one component of about 1,264 lines with 21 useState calls, and every new view adds to its one key handler. The change splits it into one component per mode with a mode reducer. Key bindings and screens do not change. Built by dipo: it is off dipo's run path.

```dipo
branch: "DIPO-443/split-tui-main-screen"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the TUI tests pass unchanged after the split"
    - kind: "automated"
      check: "(unit) a reducer test covers each mode change"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The TUI main screen is one component per mode with a mode reducer, and app.tsx keeps only the wiring
- [x] #2 Key bindings and screens are unchanged, and the existing TUI tests pass unchanged
- [x] #3 A reducer test covers each mode change
<!-- AC:END -->
