---
id: DIPO-479
title: 'Type and move in the planning view like Claude Code: Enter sends, Plan on 5'
status: In Progress
assignee: []
created_date: '2026-11-10 15:21'
updated_date: '2026-11-10 17:18'
labels:
  - 'tier:M'
milestone: m-6
dependencies: []
references:
  - packages/tui/src/planning.tsx
  - packages/tui/src/composer.tsx
  - packages/tui/src/keys.ts
  - packages/tui/src/home.tsx
  - packages/tui/src/app.tsx
  - packages/tui/src/queue.tsx
  - packages/tui/src/planning.test.tsx
  - docs/design/tui-v2/keymap.json
  - docs/design/tui-v2/migration.md
  - docs/decisions/0009-tui.md
modified_files:
  - docs/decisions/0009-tui.md
  - docs/design/tui-v2/keymap.json
  - docs/design/tui-v2/migration.md
  - docs/design/tui-v2/screens/05-queue.txt
  - docs/design/tui-v2/screens/06-retro.txt
  - docs/design/tui-v2/screens/07-plan.txt
  - docs/design/tui-v2/screens/13-keys-overlay.txt
  - docs/design/tui-v2/spec.md
  - packages/tui/src/app.tsx
  - packages/tui/src/composer.test.tsx
  - packages/tui/src/composer.tsx
  - packages/tui/src/footer.test.ts
  - packages/tui/src/home.tsx
  - packages/tui/src/keys.ts
  - packages/tui/src/mode.ts
  - packages/tui/src/palette.test.tsx
  - packages/tui/src/planning.test.tsx
  - packages/tui/src/planning.tsx
  - packages/tui/src/proposal-form.test.ts
  - packages/tui/src/proposal-form.ts
  - packages/tui/src/queue.test.tsx
  - packages/tui/src/queue.tsx
  - packages/tui/src/retro.test.tsx
  - packages/tui/src/retro.tsx
priority: high
type: feature
ordinal: 451000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want Enter to send and Shift+Enter to make a new line in the planning view, the Plan view on key 5 beside the other rooms, and run now on r in the Queue, so that planning types like the Claude CLI and the keys I use most need no modifier.

M6 (TUI v2). The maintainer's hand test of the planning session on 2026-11-10: "The whole view is not efficient yet. I want a more claude cli environment in the planning." The findings were split into three stories after review: DIPO-479 input and keys, DIPO-486 rendering, DIPO-487 layout, cards and the Ready step.

1. Ctrl-S to send is "a weird command" (on main: packages/tui/src/planning.tsx:10-11 and packages/tui/src/composer.tsx:29-47). Enter sends; Shift+Enter makes a new line. Many terminals send the same byte for Shift+Enter as for Enter unless they are set up for it (Claude Code's `/terminal-setup` does that for some terminals). The maintainer uses Warp: the manual test records what Warp sends for Shift+Enter and whether it needs a Warp setting. A fallback that always works exists: Option+Enter (ESC CR, with Option as Meta) and a trailing backslash before Enter, as Claude Code accepts.
2. Ctrl-E ends the session after a yes (planning.tsx:11 and :530-537). It becomes `/end` typed in the input, which does the same until DIPO-487 turns it into the Ready step.
3. Keys (the maintainer, 2026-11-10): planning becomes its own main view on key 5, beside 1 to 4, instead of P, and P no longer opens it. On main P is the planning key in `NAV_KEYS` (packages/tui/src/keys.ts:883-889), the footer entry `plan` (keys.ts:780), the overlay exits (`leavesOverlay`, packages/tui/src/home.tsx:166-169) and the app's key handler (packages/tui/src/app.tsx:301). The Retro's "discuss in a plan" (keymap.json `discussPlan`, key P) moves to d in the Retro, the first letter of its label and free there. In the Queue, run now moves from R to r (keymap.json `runNow`, keys.ts:718 `queueRun`); r is free in the Queue, and r on the Desk stays resume and retry.

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

The other Composer prompts (steer, answer, note, top-up) keep Ctrl-S; they are not part of this story.

ADR 0009 lines that change (the maintainer approves the wording in this story's PR): section 3's first line ("Rooms are numbered 1 to 4: Desk, Floor, Queue and Retro. P opens planning, O opens Offices, and Enter drills in."), which becomes rooms 1 to 5 with Plan on 5; section 4's actions table row "R | work.run", which becomes r; and the Global keys line ("1 to 4, P, O, Tab, ..."), which becomes 1 to 5, O, Tab. One line in its Replaced list names Ctrl-S and Ctrl-E in the planning view, P for planning and R for run now.

Tier M: terminal key sequences, the room keys of three views, keymap.json and three ADR lines.

```dipo
branch: "DIPO-479/planning-input-and-keys"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) in the Plan input, CR sends planning.message; ESC CR, a trailing backslash before CR, and the Shift+Enter sequences CSI 13;2u and CSI 27;2;13~ insert a new line; Ctrl-S no longer sends"
    - kind: "automated"
      check: "(unit) /end then Enter asks to end and y sends planning.end; Ctrl-E does nothing; no modifier key acts in the Plan input"
    - kind: "automated"
      check: "(unit) 5 opens the Plan view from every room and overlay exit, P opens nothing, d in the Retro starts the discuss-in-a-plan session, r in the Queue sends work.run, R in the Queue does nothing, r on the Desk still resumes"
    - kind: "automated"
      check: "(unit) the keys overlay and the footer list the key table's rows from the registry, and keymap.json holds them"
    - kind: "manual"
      check: "In Warp, press 5, type two lines with Shift+Enter, then with Option+Enter and with a trailing backslash, send with Enter, then type /end"
      expect: "Each way makes a new line, Enter sends, /end asks to end; note what Warp sends for Shift+Enter and whether a Warp setting was needed"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 In the Plan view's input Enter sends and Shift+Enter makes a new line; Option+Enter and a trailing backslash before Enter always make a new line; Ctrl-S no longer sends there
- [x] #2 Ctrl-E is replaced by /end typed in the input, which ends the session after a yes; the Plan input has no modifier shortcut
- [x] #3 Planning opens on key 5 as the fifth main view and P no longer opens it; the Retro's discuss in a plan moves from P to d; in the Queue run now moves from R to r, and r on the Desk is unchanged
- [x] #4 keymap.json, the keys overlay and the footer hold the story's key table
- [x] #5 ADR 0009's section 3 first line, section 4's R row and the Global keys line describe key 5, Enter to send and r for run now, with one Replaced line for Ctrl-S, Ctrl-E, P and R
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-10 17:02 UTC
- Criteria met: 5 of 5 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 1, failed 0
- Budget used: 162,268 of 800,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 0
<!-- SECTION:FINAL_SUMMARY:END -->
