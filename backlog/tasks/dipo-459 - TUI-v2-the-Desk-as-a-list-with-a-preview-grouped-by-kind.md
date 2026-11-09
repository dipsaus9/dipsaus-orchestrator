---
id: DIPO-459
title: 'TUI v2: the Desk as a list with a preview, grouped by kind'
status: In Progress
assignee: []
created_date: '2026-11-06 14:12'
updated_date: '2026-11-09 10:32'
labels:
  - 'tier:L'
milestone: m-6
dependencies:
  - DIPO-458
  - DIPO-452
  - DIPO-454
references:
  - packages/tui/src/desk.tsx
  - packages/tui/src/keys.ts
  - packages/contract/src/office.ts
  - docs/design/tui-v2/spec.md
  - docs/design/tui-v2/screens/01-desk.txt
  - docs/design/tui-v2/screens/11-desk-previews.txt
  - docs/design/tui-v2/screens/14-desk-proposals.txt
  - docs/design/tui-v2/screens/15-budget-and-failed.txt
  - docs/design/tui-v2/screens/16-narrow.txt
  - docs/design/tui-v2/screens/12-states.txt
  - docs/design/tui-v2/designs/dipo-ux-spec.html
priority: medium
type: feature
ordinal: 432000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want the Desk split into a list and a preview that shows everything an item needs me to decide, so that I can decide without opening anything or guessing a truncated line.

Step 3. At 100 columns or more: a NEEDS YOU heading and a list grouped by kind (SETUP, PROPOSALS · from your AI team) in engine order with setup kinds first, and a preview from DeskItem (detail, blocks, since, hand, buttons for bound actions, cli lines for unbound ones). NEXT UP gets y/n. QUESTION and PARKED open the Composer per spec.md; PARKED budget-exceeded offers +25% / +50% / +100%. The header shows ● plan open while a planning session is open. Three engine additions land here: KNOWN_DESK_KINDS puts the setup kinds first, the office read carries a since-you-last-looked summary for the Since band, and DeskAction gets an optional consequence line. Two more: the story PR read carries the required-check count and state and the change stats (files, +/−) from gh/git for the MERGE preview, and the PROPOSAL preview shows the story text, Why, Blocks, Size (tier) and Raised … by <role> (<model>) produced by the M3 idea audit (DIPO-452, DIPO-454). The first button is the primary one. The Since band, the empty Desk, the budget reached and run failed states, pending rows with ^R retry, and the discard and drop prompts are drawn as the screens show.

Design: docs/design/tui-v2/ (spec.md, screens/, keymap.json, roles.json, migration.md). The screens must match `docs/design/tui-v2/designs/dipo-ux-spec.html` exactly; the text mocks in `screens/` are the same screens in text. Where spec.md's Maintainer decisions (2026-11-06) differ from the HTML, the text files win.

```dipo
branch: "DIPO-459/tui-v2-desk"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) desk groups follow KNOWN_DESK_KINDS and keep engine order"
    - kind: "automated"
      check: "(unit) resume prompt fields per park reason"
    - kind: "manual"
      check: "With a proposal and a parked story on the desk, accept the proposal with y and resume the park with r"
      expect: "Focus moves to the next item and the resume prompt shows the caps before and after the top-up"
    - kind: "manual"
      check: "With a proposal, a merge item and a parked story on the desk, open the TUI at 112 and at 80 columns next to designs/dipo-ux-spec.html S1, S1b, S1c, S6 and S7 (pending, discard and drop)"
      expect: "List, group headers, preview, buttons, consequence and cli lines match the HTML preview side by side"
    - kind: "automated"
      check: "(unit) KNOWN_DESK_KINDS lists the setup kinds first and the desk keeps the engine order"
    - kind: "automated"
      check: "(unit) the office read carries the since-you-last-looked summary and the Since band prints it"
    - kind: "automated"
      check: "(unit) a DeskAction consequence shows under the buttons, with the TUI map as fallback"
    - kind: "automated"
      check: "(unit) the story PR read carries required-check count and state and change stats, and the MERGE preview prints them"
    - kind: "automated"
      check: "(unit) the PROPOSAL preview shows the audit's story text, Why, Blocks, Size tier and Raised by role and model"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 At 100 columns or wider the Desk shows a list grouped by kind in the engine's order and a preview of the focused item
- [ ] #2 The preview shows detail, blocks, since, hand, the bound actions as buttons and the cli line, and never truncates
- [ ] #3 y and n act on what the item asks: approve/reject, accept/dismiss, confirm/decline
- [ ] #4 Resume asks only for what the park reason needs, as spec.md lists
- [ ] #5 Below 100 columns the Desk is one list and Enter opens the preview
- [ ] #6 The Since 09:41 band shows above the list at 100 columns or wider and any key dismisses it
- [ ] #7 The empty Desk, budget reached, run failed, pending and retry rows, and the discard and drop prompts read as screens/12-states.txt and screens/15-budget-and-failed.txt show
- [ ] #8 The Desk at 112 and at 80 columns matches the HTML preview's S1, S1b, S1c and S6. The screens must match `docs/design/tui-v2/designs/dipo-ux-spec.html` exactly; the text mocks in `screens/` are the same screens in text
- [ ] #9 KNOWN_DESK_KINDS puts the setup kinds first (engine addition); the TUI still never re-sorts
- [ ] #10 The office read carries a since-you-last-looked summary (merged, new proposals, spend since a time) that the Since band shows (engine addition)
- [ ] #11 DeskAction has an optional consequence line (engine addition) that the preview shows under the buttons
- [ ] #12 The story PR read carries the required-check count and state and the change stats (files, +/−) from gh/git (engine addition), and the MERGE preview shows them
- [ ] #13 The PROPOSAL preview shows the story text, Why, Blocks, Size (the audit's tier only) and Raised … by <role> (<model>) as produced by the M3 idea audit (DIPO-452, DIPO-454)
- [ ] #14 The header shows ● plan open at the right while a planning session is open
- [ ] #15 QUESTION opens the Composer to answer
<!-- AC:END -->
