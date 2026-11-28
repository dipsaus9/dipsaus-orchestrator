---
id: DIPO-521
title: >-
  Plan view: no cut answers, one fold line per answer, one line per filed story,
  reasons for refusals
status: In Progress
assignee: []
created_date: '2026-11-28 14:11'
updated_date: '2026-11-28 19:00'
labels:
  - 'tier:S'
  - 'role:developer'
milestone: m-6
dependencies:
  - DIPO-520
references:
  - packages/tui/src/transcript.ts
  - packages/tui/src/planning.tsx
  - packages/tui/src/markdown.ts
  - docs/design/chat-and-activity/spec.md
  - docs/design/tui-v2/screens/07-plan.txt
priority: high
type: bug
ordinal: 482000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want every answer in the planning view readable in full and free of noise, so that I can act on what dipo says without scrolling past tool lines or losing words at the edge.

Within the DIPO-487 layout of 07-plan.txt (it stays: one column, `> ` blocks on shade, `●` answers, cards, one-line input). Seen on 2026-11-27: answer rows are drawn with `wrap="truncate-end"` after an extra indent, so line ends can be lost; each thinking, grep and read of an answer is its own row; lists inside answers use `●`, the answer marker; a filed story shows under the answer and again under IN THIS PLAN while the fold-out is open; `set Ready DIPO-116: 1 refused` names no reason; the head rule is not faint (planning.tsx:1095).

Design: docs/design/chat-and-activity/ (spec.md, The chat; screens/02-chat-room.txt rows 10 to 26 for the answer, fold and filed lines). The mocks win; a cell difference is a bug (DIPO-520).

```dipo
branch: "DIPO-521/plan-view-readable"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) an answer longer than the column wraps at the indent's width and no answer row ends in an ellipsis"
    - kind: "automated"
      check: "(unit) the fold lines of one answer become one dim line with counts, time and tokens, and ⏎ opens them"
    - kind: "automated"
      check: "(unit) a markdown list item in an answer starts with ·"
    - kind: "automated"
      check: "(integration) 07-plan.txt passes expectScreen whole"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 No answer row is cut; answers wrap at the width the indent leaves
- [ ] #2 An answer's tool and thinking lines fold into one dim line that ⏎ opens; lists inside answers use · and never ●
- [ ] #3 A confirmed proposal shows as one line in the conversation; the fold-out lists it once
- [ ] #4 A refused command names its reason in words (for example: set Ready DIPO-116 refused: R15 the unknowns list is missing)
- [ ] #5 The head rule is faint and 07-plan.txt passes expectScreen
<!-- AC:END -->
