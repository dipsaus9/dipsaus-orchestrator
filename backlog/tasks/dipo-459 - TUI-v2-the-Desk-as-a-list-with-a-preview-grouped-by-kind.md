---
id: DIPO-459
title: 'TUI v2: the Desk as a list with a preview, grouped by kind'
status: Done
assignee: []
created_date: '2026-11-06 14:12'
updated_date: '2026-11-09 17:54'
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
modified_files:
  - docs/design/tui-v2/spec.md
  - packages/cli/src/tui-command.ts
  - packages/contract/schema/events.schema.json
  - packages/contract/schema/reads.schema.json
  - packages/contract/schema/work.schema.json
  - packages/contract/src/ideas.ts
  - packages/contract/src/office.ts
  - packages/contract/src/work.test.ts
  - packages/contract/src/work.ts
  - packages/engine/src/create/steps.ts
  - packages/engine/src/overview/desk.ts
  - packages/engine/src/overview/digest.ts
  - packages/engine/src/prompts/contract/audit-box.md
  - packages/engine/src/run/idea-audits.ts
  - packages/engine/src/story-pr/git.ts
  - packages/engine/src/story-pr/index.ts
  - packages/engine/src/story-pr/prs.ts
  - packages/engine/test/overview/desk.test.ts
  - packages/engine/test/overview/digest.test.ts
  - packages/engine/test/run/idea-answers.test.ts
  - packages/engine/test/run/ideas.test.ts
  - packages/engine/test/run/next-up.test.ts
  - packages/engine/test/story-pr/ci.test.ts
  - packages/tui/src/actions.test.ts
  - packages/tui/src/actions.ts
  - packages/tui/src/app.tsx
  - packages/tui/src/checklist.test.tsx
  - packages/tui/src/desk-preview.test.ts
  - packages/tui/src/desk-preview.ts
  - packages/tui/src/desk.test.tsx
  - packages/tui/src/desk.tsx
  - packages/tui/src/detail.test.tsx
  - packages/tui/src/digest.test.tsx
  - packages/tui/src/digest.ts
  - packages/tui/src/footer.test.ts
  - packages/tui/src/footer.ts
  - packages/tui/src/format.ts
  - packages/tui/src/header.test.ts
  - packages/tui/src/home.tsx
  - packages/tui/src/keys.ts
  - packages/tui/src/modes.tsx
  - packages/tui/src/overview.tsx
  - packages/tui/src/palette.test.tsx
  - packages/tui/src/prompt-box.ts
  - packages/tui/src/run.tsx
  - packages/tui/src/screen.tsx
  - packages/tui/src/segments.tsx
  - packages/tui/src/views.tsx
  - packages/tui/test/support/setup.tsx
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
- [x] #1 At 100 columns or wider the Desk shows a list grouped by kind in the engine's order and a preview of the focused item
- [x] #2 The preview shows detail, blocks, since, hand, the bound actions as buttons and the cli line, and never truncates
- [x] #3 y and n act on what the item asks: approve/reject, accept/dismiss, confirm/decline
- [x] #4 Resume asks only for what the park reason needs, as spec.md lists
- [x] #5 Below 100 columns the Desk is one list and Enter opens the preview
- [x] #6 The Since 09:41 band shows above the list at 100 columns or wider and any key dismisses it
- [x] #7 The empty Desk, budget reached, run failed, pending and retry rows, and the discard and drop prompts read as screens/12-states.txt and screens/15-budget-and-failed.txt show
- [x] #8 The Desk at 112 and at 80 columns matches the HTML preview's S1, S1b, S1c and S6. The screens must match `docs/design/tui-v2/designs/dipo-ux-spec.html` exactly; the text mocks in `screens/` are the same screens in text
- [x] #9 KNOWN_DESK_KINDS puts the setup kinds first (engine addition); the TUI still never re-sorts
- [x] #10 The office read carries a since-you-last-looked summary (merged, new proposals, spend since a time) that the Since band shows (engine addition)
- [x] #11 DeskAction has an optional consequence line (engine addition) that the preview shows under the buttons
- [x] #12 The story PR read carries the required-check count and state and the change stats (files, +/−) from gh/git (engine addition), and the MERGE preview shows them
- [x] #13 The PROPOSAL preview shows the story text, Why, Blocks, Size (the audit's tier only) and Raised … by <role> (<model>) as produced by the M3 idea audit (DIPO-452, DIPO-454)
- [x] #14 The header shows ● plan open at the right while a planning session is open
- [x] #15 QUESTION opens the Composer to answer
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parked 2026-11-09 17:37 UTC: by-maintainer
- Detail: stale gate after main merge
- Run: run_01M6ZXSZ3AVJEYS383ZVTHT49F
- Criteria met: 15 of 15 (as the worker reported them)
- Loops: 3 of 8; CI attempts: 0 of 2
- Review rounds: 1, failed 0 of 3
- Budget used: 819,562 of 2,000,000 tokens; 288 of 300 turns; 383 of 180 minutes
- Last good commit: 254d557efc7eb93313f29650ac975eef1a5bba2e

Resumed 2026-11-09 17:37 UTC; grants: none; note: none
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-09 17:54 UTC
- Criteria met: 15 of 15 (as the worker reported them)
- Loops: 3; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 2, failed 0
- Budget used: 819,562 of 2,000,000 tokens
- Runs: 1; resumes: 1
- Parks: 1
  - 2026-11-09 17:37 UTC by-maintainer: stale gate after main merge
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 6
<!-- SECTION:FINAL_SUMMARY:END -->
