---
id: DIPO-461
title: 'TUI v2: the run stream as a readable table with folded thinking'
status: In Review
assignee: []
created_date: '2026-11-06 14:12'
updated_date: '2026-11-10 08:13'
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
unknowns:
  - q: "Criterion 9 (finished stream lines render with Ink Static) conflicts with the fixed-height scrolling stream pane on the alternate screen: Static output goes above the frame, and it cannot be scrolled, filtered by tab or paused. May I change criterion 9 to \"finished stream lines are memoised and never re-render\" (the current implementation), and reword spec.md and migration.md to match? Or do you want Static used anyway, for example only in the inline mode (`--inline`)?"
    status: "resolved"
    answer: "Yes: change criterion 9 to finished stream lines are memoised and never re-render; keep the scrolling pane"
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
- [x] #1 Tool lines show time, verb and target on one line, with the full command on Enter
- [x] #2 Consecutive thinking lines fold into one with their count and tokens
- [x] #3 The worker, reviewer, verify and prompt sources are filter tabs in one stream
- [x] #4 Scrolling up pauses following and G follows again
- [x] #5 Steer opens the Composer in the stream and the sent text shows with next-turn or on-resume
- [x] #6 The Run screen and the steer prompt match the HTML preview's S3 and S7. The screens must match `docs/design/tui-v2/designs/dipo-ux-spec.html` exactly; the text mocks in `screens/` are the same screens in text
- [x] #7 v switches the stream filter on the Run, and tab stays next pane
- [x] #8 says and verdict lines are bright (hi)
- [x] #9 Finished stream lines render with Ink Static, so they never re-render
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parked 2026-11-09 22:40 UTC: ambiguous-spec
- Detail: Criterion 9 (finished stream lines render with Ink Static) conflicts with the fixed-height scrolling stream pane on the alternate screen: Static output goes above the frame, and it cannot be scrolled…
- Run: run_01M7166VR4A0PVVGF9M1V8NDPV
- Criteria met: 8 of 9 (as the worker reported them)
- Loops: 0 of 5; CI attempts: 0 of 2
- Review rounds: 1, failed 1 of 3
- Budget used: 314,473 of 800,000 tokens; 111 of 200 turns; 18 of 90 minutes
- Last good commit: 73331b45656f0105704fdc787272c2fcea6fe80e

Resumed 2026-11-10 08:11 UTC; grants: none; note: Yes: change criterion 9 to finished stream lines are memoised and never re-render; keep the scrolling pane
<!-- SECTION:NOTES:END -->
