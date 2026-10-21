---
id: DIPO-284
title: Park a live question at once when the last TUI disconnects
status: In Review
assignee: []
created_date: '2026-10-21 14:35'
updated_date: '2026-10-21 16:50'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/daemon/src/server.ts
  - packages/daemon/test/integration/presence.test.ts
  - packages/engine/src/hooks/permissions.ts
  - packages/engine/src/run/live-question.ts
  - packages/engine/test/hooks/
  - packages/engine/test/run/live-question.test.ts
  - packages/daemon/src/foreground.ts
type: feature
ordinal: 273000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: when the last connected TUI closes, every open live question closes straight away and its story parks with the question, instead of waiting out the permission timeout.

Context: DIPO-279 made a question live only while a TUI is connected at the moment it is asked. Maintainer choice of 2026-10-21: closing the last TUI parks the story at once (0021 section 11, live questions only while the maintainer has the TUI open).

```dipo
branch: "DIPO-284/park-on-tui-close"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 When the last TUI connection closes, the daemon tells the engine, and every open live question ends without a decision so its story parks with the question
- [x] #2 A question asked while another TUI is still connected stays live
- [x] #3 Tests cover the last TUI closing during a live question, a second TUI staying connected, and a reconnect after the park
<!-- AC:END -->
