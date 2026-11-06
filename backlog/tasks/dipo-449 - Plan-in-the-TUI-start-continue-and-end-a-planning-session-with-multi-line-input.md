---
id: DIPO-449
title: >-
  Plan in the TUI: start, continue and end a planning session with multi-line
  input
status: Done
assignee: []
created_date: '2026-11-05 20:51'
updated_date: '2026-11-06 12:58'
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
modified_files:
  - packages/client/src/index.ts
  - packages/client/src/store/index.ts
  - packages/client/src/store/office-store.ts
  - packages/client/test/unit/office-store.test.ts
  - packages/contract/schema/commands.schema.json
  - packages/contract/schema/events.schema.json
  - packages/contract/schema/reads.schema.json
  - packages/contract/schema/work.schema.json
  - packages/contract/src/office.ts
  - packages/contract/src/work.ts
  - packages/engine/src/create/steps.ts
  - packages/engine/src/features.ts
  - packages/engine/src/overview/feature.ts
  - packages/tui/src/app.tsx
  - packages/tui/src/footer.ts
  - packages/tui/src/mode.test.ts
  - packages/tui/src/mode.ts
  - packages/tui/src/modes.tsx
  - packages/tui/src/planning.test.tsx
  - packages/tui/src/planning.tsx
  - packages/tui/src/screen.tsx
  - packages/tui/test/support/harness.ts
  - packages/tui/test/support/setup.tsx
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
- [x] #1 The TUI has a planning view that starts a session with a kind and a goal, continues the open session and ends it
- [x] #2 Messages are written in a multi-line input where Enter adds a line and one documented key sends
- [x] #3 Each answer streams into the view as it arrives, with the session's live spend
- [x] #4 Opening the TUI shows the office's open planning session, and the view says when the session continued in a fresh Claude session
- [x] #5 The view is its own part of the TUI, and the other views and keys are unchanged
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-06 12:58 UTC
- Criteria met: 5 of 5 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 1, failed 0
- Budget used: 185,806 of 800,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 0
<!-- SECTION:FINAL_SUMMARY:END -->
