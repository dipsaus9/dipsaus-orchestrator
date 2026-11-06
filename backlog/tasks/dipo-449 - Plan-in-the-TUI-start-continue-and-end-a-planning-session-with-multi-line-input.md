---
id: DIPO-449
title: >-
  Plan in the TUI: start, continue and end a planning session with multi-line
  input
status: Refined
assignee: []
created_date: '2026-11-05 20:51'
labels:
  - 'tier:M'
milestone: m-3
dependencies:
  - DIPO-447
  - DIPO-443
references:
  - packages/tui/src/
  - packages/tui/src/app.tsx
  - packages/tui/src/actions.ts
  - packages/client/src/store/office-store.ts
  - docs/decisions/0009-tui.md
priority: high
type: feature
ordinal: 422000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want a planning view in the TUI where I start, continue and end a planning session and read each answer as it streams in, so that I plan in one place without a separate chat.

M3 (0022). Needs DIPO-447 (the session) and DIPO-443 (the TUI main screen split into one part per mode, so this view is its own part).

The TUI has single-line text prompts only today (packages/tui/src/actions.ts, the path mode in packages/tui/src/app.tsx). The view needs a multi-line input: Enter adds a line and one documented key sends. It shows the session's kind and goal, the streamed answers, live spend, the notice when the session continued in a fresh Claude session (DIPO-448), and the open session again when the TUI opens.

Built by dipo where it can (maintainer's choice, 2026-11-05); a builder agent takes over if dipo gets stuck.

```dipo
branch: "DIPO-449/tui-planning-view"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) TUI tests: start a session with a kind and goal, send a multi-line message, see the streamed answer and spend, end the session"
    - kind: "automated"
      check: "(unit) TUI tests: reopening the TUI shows the open session and continues it, and the fresh-session notice is shown"
    - kind: "manual"
      check: "On the scratch repository, start a planning session in the TUI, ask two questions, close the TUI, reopen it and ask a third"
      expect: "The session continues where it stopped and each answer streams in with its spend"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The TUI has a planning view that starts a session with a kind and a goal, continues the open session and ends it
- [ ] #2 Messages are written in a multi-line input where Enter adds a line and one documented key sends
- [ ] #3 Each answer streams into the view as it arrives, with the session's live spend
- [ ] #4 Opening the TUI shows the office's open planning session, and the view says when the session continued in a fresh Claude session
- [ ] #5 The view is its own part of the TUI, and the other views and keys are unchanged
<!-- AC:END -->
