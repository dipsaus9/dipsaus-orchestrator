---
id: DIPO-486
title: >-
  The planning view shows the answer first, with folded details, clean questions
  and rendered markdown
status: Ready
assignee: []
created_date: '2026-11-10 15:46'
updated_date: '2026-11-10 15:57'
labels:
  - 'tier:M'
milestone: m-6
dependencies:
  - DIPO-479
references:
  - packages/tui/src/planning.tsx
  - packages/tui/src/planning.test.tsx
  - packages/tui/src/question-dialog.ts
  - packages/tui/src/stream.ts
  - packages/tui/src/colour.tsx
  - docs/design/tui-v2/roles.json
priority: high
type: feature
ordinal: 458000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want the planner's answer shown first with its thinking and tool output folded, its questions as a clear list with no raw JSON, every line wrapped cleanly and its markdown rendered, so that I read a planning session at a glance as I read the Claude CLI.

M6 (TUI v2). The maintainer's hand test of the planning session on 2026-11-10: "The whole view is not efficient yet. I want a more claude cli environment in the planning." The findings were split into three stories after review: DIPO-479 input and keys, DIPO-486 rendering, DIPO-487 layout, cards and the Ready step.

1. Thinking and tool output take the space; the answer should show first. Thinking and tool lines fold to one line each by default and open on demand (Enter on a focused fold, the key table in DIPO-479). The fold reuses the thinking fold of the Run stream (DIPO-461, packages/tui/src/stream.ts), not a second one (0001).
2. When Claude asks a question, raw JSON shows above it. The question and proposal blocks the engine reads (0022) never show as text in the conversation; only their rendered form does.
3. Questions need structure and colour (packages/tui/src/question-dialog.ts): the question stands out, its options are a clear list with the recommended one marked, and the choices made are visible before sending and can be reviewed and changed.
4. Lines break wrongly in the question part. Every line wraps at the column width at word boundaries, with no broken or cut lines.
5. Claude's markdown shows raw. Headings, lists, bold, inline code and code blocks render, in the TUI's colour roles (docs/design/tui-v2/roles.json), with no new colours.

Needs DIPO-479 for the key table. The layout of the view (one column, cards, fold-out) is DIPO-487.

Tier M: one fold reused, one block filter, the question view and a small markdown renderer.

```dipo
branch: "DIPO-486/planning-rendering"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) over a fixture answer with thinking, tool lines and text, thinking and tool lines render folded to one line each through the Run stream's fold, the answer text first, and Enter on a focused fold opens and folds it again"
    - kind: "automated"
      check: "(unit) an answer that ends in a question block renders the question view only, with no JSON or fence text on screen; the same for a proposal block"
    - kind: "automated"
      check: "(unit) the question view marks the question, lists the options with the recommended one marked, shows the chosen answers before sending, and lets a choice change before sending"
    - kind: "automated"
      check: "(unit) at 80 and 112 columns no rendered conversation or question line is wider than the column, and long words and option descriptions wrap at word boundaries"
    - kind: "automated"
      check: "(unit) markdown headings, lists, bold, inline code and code blocks render with colour roles from roles.json; a test fails on a colour not in roles.json"
    - kind: "manual"
      check: "In Warp, ask the planner something that makes it think, read files and then ask a question with options"
      expect: "Thinking and tool lines are folded to one line each, the answer shows first, the question shows with no JSON above it, options are a clear list, lines wrap cleanly and markdown renders"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Thinking and tool output fold to one line each by default, the answer text shows first, and a folded line opens on demand without a modifier key, through the Run stream's fold (DIPO-461), not a second one
- [ ] #2 The question and proposal blocks the engine reads never show as raw JSON or fence text in the conversation; only their rendered form shows
- [ ] #3 A question renders with the question set apart, its options as a list with the recommended one marked, and the chosen answers visible and changeable before sending
- [ ] #4 Every line of the conversation and of the question view wraps at the column width at word boundaries, with no broken or cut lines
- [ ] #5 Claude's markdown (headings, lists, bold, inline code, code blocks) renders in the TUI's colour roles, with no new colours
<!-- AC:END -->
