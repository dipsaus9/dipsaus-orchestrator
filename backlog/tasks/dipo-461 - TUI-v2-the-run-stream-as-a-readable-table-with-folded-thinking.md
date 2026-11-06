---
id: DIPO-461
title: 'TUI v2: the run stream as a readable table with folded thinking'
status: Refined
assignee: []
created_date: '2026-11-06 14:12'
updated_date: '2026-11-06 14:17'
labels:
  - 'tier:M'
milestone: m-6
dependencies:
  - DIPO-460
references:
  - packages/tui/src/output.ts
  - packages/tui/src/detail.tsx
  - docs/design/tui-v2/spec.md
  - docs/design/tui-v2/screens/03-run.txt
  - docs/design/tui-v2/designs/dipo-ux-spec.html
priority: medium
type: feature
ordinal: 434000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want the live run as a table of time, verb and target with thinking folded and the agent's own words bright, so that I can follow what it does by skimming.

Step 5. Fold consecutive thinking into one line. says and verdict are bright. Sources are filter tabs (all, worker, reviewer, verify, prompt), replacing today's w, v and i, switched with v (tab stays next pane on the Run). Scrolling up pauses following. Steer opens the Composer at the foot, and a sent message shows as a you line with its delivery state. Finished lines render with Ink Static.

Design: docs/design/tui-v2/ (spec.md, screens/, keymap.json, roles.json, migration.md). The screens must match `docs/design/tui-v2/designs/dipo-ux-spec.html` exactly; the text mocks in `screens/` are the same screens in text. Where spec.md's Maintainer decisions (2026-11-06) differ from the HTML, the text files win.

```dipo
branch: "DIPO-461/tui-v2-run-stream"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) thinking folding over a fixture stream"
    - kind: "automated"
      check: "(unit) steer shows the delivered state from the reply"
    - kind: "manual"
      check: "Watch a running story with Enter on the Floor next to designs/dipo-ux-spec.html S3, then steer it with s"
      expect: "Left column, filter tabs, stream table, folded thinking, says and verdict lines, the steer Composer and the you line match the HTML preview side by side"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Tool lines show time, verb and target on one line, with the full command on Enter
- [ ] #2 Consecutive thinking lines fold into one with their count and tokens
- [ ] #3 The worker, reviewer, verify and prompt sources are filter tabs in one stream
- [ ] #4 Scrolling up pauses following and G follows again
- [ ] #5 Steer opens the Composer in the stream and the sent text shows with next-turn or on-resume
- [ ] #6 The Run screen and the steer prompt match the HTML preview's S3 and S7. The screens must match `docs/design/tui-v2/designs/dipo-ux-spec.html` exactly; the text mocks in `screens/` are the same screens in text
- [ ] #7 v switches the stream filter on the Run, and tab stays next pane
- [ ] #8 says and verdict lines are bright (hi)
- [ ] #9 Finished stream lines render with Ink Static, so they never re-render
<!-- AC:END -->
