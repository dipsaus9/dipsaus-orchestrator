---
id: DIPO-487
title: >-
  The planning view is one conversation column with inline story cards and a
  Ready step
status: In Review
assignee: []
created_date: '2026-11-10 15:46'
updated_date: '2026-11-10 18:09'
labels:
  - 'tier:M'
milestone: m-6
dependencies:
  - DIPO-479
references:
  - packages/tui/src/planning.tsx
  - packages/tui/src/planning.test.tsx
  - packages/tui/src/proposal-form.ts
  - packages/tui/src/keys.ts
  - packages/contract/src/work.ts
  - docs/design/tui-v2/screens/07-plan.txt
  - docs/design/tui-v2/spec.md
  - docs/design/tui-v2/migration.md
  - docs/decisions/0009-tui.md
modified_files:
  - docs/decisions/0009-tui.md
  - docs/design/tui-v2/migration.md
  - docs/design/tui-v2/screens/07-plan.txt
  - docs/design/tui-v2/spec.md
  - packages/tui/src/footer.test.ts
  - packages/tui/src/keys.ts
  - packages/tui/src/planning.test.tsx
  - packages/tui/src/planning.tsx
  - packages/tui/src/screen.tsx
priority: high
type: feature
ordinal: 459000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want the planning view as one conversation column with proposed stories as compact cards I act on with c, e and x, confirmed ones out of the way, and a Ready step at the end where I tick the stories that go Ready, so that only what still needs my decision competes for my attention.

M6 (TUI v2). The maintainer's hand test of the planning session on 2026-11-10: "The whole view is not efficient yet. I want a more claude cli environment in the planning." The findings were split into three stories after review: DIPO-479 input and keys, DIPO-486 rendering, DIPO-487 layout, cards and the Ready step.

1. Layout: today the view is a centred script with a side rail and a boxed input (docs/design/tui-v2/screens/07-plan.txt). It becomes one conversation column like Claude Code: your message, the answer, the folded details, and one input at the foot, with nothing else competing for space. The stories rail becomes a fold-out on Tab (IN THIS PLAN, DECISIONS, ON END). Proposed stories show inline as compact cards (title, tier, first story line). On main the view uses modifier keys for proposals (packages/tui/src/planning.tsx:15-23, packages/tui/src/keys.ts:525-549: Ctrl-Y confirm, Ctrl-D decline, Ctrl-R edit, Ctrl-G Ready); c, e and x on a focused card replace them, as the key table below says: c sends `planning.confirm`, x sends `planning.decline`, e puts the proposal's form in the input where Enter sends `planning.edit`. With an empty input, Up moves focus into the conversation; Up and Down move between folded lines and cards; Esc or any other printable key returns focus to the input. This layout is the agent's recommendation; the maintainer approves the design wording in this story's PR.
2. "If I approved a proposal it doesn't go away in the planning session." On main `proposalLines` (planning.tsx:634-664) lists every proposal whatever its state, three rows ending at the selected one (:648), and only counts the open ones (:651); `stepSelection` (:99-108) moves over all of them, although only open and failed ones take a decision (`decidable`, :95-97). A proposal the maintainer confirmed leaves the open proposals at once and shows only as one compact line in the conversation: "filing…" while its state is `filing`, then "filed as DIPO-n" once `filed` (the ids from `stories`, packages/contract/src/work.ts:726-746); DIPO-481 adds the backlog PR it waits on to that line. A declined one leaves too. Only proposals that still need a decision (open, and failed with the lane's reason) stay as cards and take the selection.
3. The Ready step. On main there is no end preview: Ctrl-G puts the session's filed stories into the input, one per line, and the lines the maintainer keeps go Ready (planning.tsx:21-23), while Ctrl-E ends after a yes (:11, :530-537). The Ready step replaces both: `/end` opens it; it lists each story the session filed or edited that is not Ready yet, with its id, title and state, all ticked; space ticks or unticks the focused one; Y sends `planning.ready` with the ticked stories and, once that answers, `planning.end`; each story then shows set, queued or refused with the gate's messages (a refused one stays Refined); n ends with no story set Ready; Esc goes back with the session open. With nothing to list, the step says so and asks to end.

The final key set of the Plan view (all three stories use it; DIPO-479 writes it into keymap.json):

| Where | Key | Does |
|---|---|---|
| Any room or overlay exit | 5 | opens the Plan view (P no longer does) |
| Plan input | Enter | sends the message (`planning.message`) |
| Plan input | Shift+Enter, Option+Enter, or a trailing backslash then Enter | new line |
| Plan input | /end then Enter | opens the Ready step (DIPO-487); until DIPO-487 lands, ends the session after a yes, as Ctrl-E does today |
| Plan input | Up on an empty input | moves focus into the conversation (DIPO-487) |
| Plan input | Tab | opens or closes the stories fold-out (DIPO-487) |
| Plan input | Esc | leaves the Plan view; the session stays open |
| Conversation focus | Up, Down | moves between folded lines and cards |
| Conversation focus | Enter | opens or folds the focused line |
| Card focus (an open or failed proposal) | c | confirms it (`planning.confirm`) |
| Card focus | e | puts the proposal's form in the input; Enter there sends `planning.edit`, Esc cancels |
| Card focus | x | declines it (`planning.decline`) |
| Conversation or card focus | Esc, or any other printable key | focus back to the input; the key is typed there |
| Ready step | Up, Down | moves between the listed stories |
| Ready step | space | ticks or unticks the focused story (all ticked when the step opens) |
| Ready step | Y | sends `planning.ready` with the ticked stories, then `planning.end` |
| Ready step | n | sends `planning.end` with no story set Ready |
| Ready step | Esc | back to the conversation; the session stays open |
| Retro | d | discuss in a plan (keymap.json `discussPlan`, was P) |
| Queue | r | run now (`work.run`, keymap.json `runNow`, was R) |

Removed: Ctrl-S and Ctrl-E (DIPO-479); Ctrl-Y, Ctrl-D, Ctrl-R and Ctrl-G (DIPO-487); P for planning and R in the Queue (DIPO-479). The maintainer asked for Cmd instead of Ctrl, but Warp keeps Cmd shortcuts for itself, so the chat drops modifier shortcuts instead.

Design files change to match: docs/design/tui-v2/screens/07-plan.txt, spec.md (the Plan section, and a note that the text mock wins over the HTML's mock 11) and migration.md; keymap.json is DIPO-479's. ADR 0009's Planning line in section 3 ("**Planning** (P). ... with one it shows kind, goal, state, live spend and the streamed answers, takes multi-line messages, shows Claude's question blocks as a dialog, and confirms proposals and the final Ready step.") gets the conversation column, the inline cards and the Ready step, with one Replaced line for the centred script with side rail and the modifier keys for proposals and Ready.

Needs DIPO-479 for the input and key table.

Tier M: the layout of one view, the cards and their keys, and the Ready step.

```dipo
branch: "DIPO-487/planning-layout-and-ready-step"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the Plan view renders one conversation column and one input at the foot; Tab opens and closes the stories fold-out"
    - kind: "automated"
      check: "(unit) a proposed story renders as an inline card; with the card focused c sends planning.confirm, x sends planning.decline, e puts its form in the input and Enter there sends planning.edit; Esc and any other printable key return focus to the input; Ctrl-Y, Ctrl-D, Ctrl-R and Ctrl-G do nothing"
    - kind: "automated"
      check: "(unit) after c on a proposal, a view with it filing shows one 'filing…' line and no card, a view with it filed shows one 'filed as DIPO-n' line, a declined one shows no card, and the selection moves only over open and failed proposals"
    - kind: "automated"
      check: "(unit) /end opens the Ready step listing the session's filed and edited stories not yet Ready, all ticked; space unticks one; Y sends planning.ready with the ticked ones and then planning.end; the result shows set, queued or refused with the gate's messages; n sends only planning.end; Esc keeps the session open"
    - kind: "automated"
      check: "(unit) the rendered view matches docs/design/tui-v2/screens/07-plan.txt at 112 columns"
    - kind: "manual"
      check: "In Warp, in a planning session, confirm a proposal with c, decline one with x, edit one with e, then type /end, untick one story and press Y"
      expect: "Confirmed and declined cards leave at once, the confirmed one shows filing… then filed as DIPO-n, and the Ready step sets the ticked stories Ready and ends the session"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The Plan view is one conversation column with one input at the foot, and the stories rail is a fold-out on Tab
- [x] #2 Proposed stories show inline as compact cards; with a card focused c sends planning.confirm, x sends planning.decline and e puts its form in the input where Enter sends planning.edit; Esc or any other printable key returns focus to the input; Ctrl-Y, Ctrl-D, Ctrl-R and Ctrl-G are gone
- [x] #3 A confirmed proposal leaves the open proposals at once and shows only as one compact line, 'filing…' and then 'filed as DIPO-n'; a declined one leaves too; only open and failed proposals stay as cards and take the selection
- [x] #4 /end opens the Ready step: it lists the session's filed and edited stories not yet Ready, all ticked; space toggles one; Y sends planning.ready with the ticked stories and then planning.end and shows each story set, queued or refused with the gate's messages; n ends with none set Ready; Esc keeps the session open
- [x] #5 screens/07-plan.txt, spec.md and migration.md describe the new Plan view, and the view matches 07-plan.txt
- [x] #6 ADR 0009's Planning line describes the conversation column, the inline cards and the Ready step, with one Replaced line for the centred script, the side rail and the modifier keys for proposals and Ready
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-10 18:01 UTC
- Criteria met: 6 of 6 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 1, failed 0
- Budget used: 201,156 of 800,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 0
<!-- SECTION:FINAL_SUMMARY:END -->
