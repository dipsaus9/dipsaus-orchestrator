---
id: DIPO-479
title: The planning session reads and types like Claude Code
status: Refined
assignee: []
created_date: '2026-11-10 15:21'
updated_date: '2026-11-10 15:37'
labels:
  - 'tier:L'
milestone: m-6
dependencies: []
references:
  - packages/tui/src/planning.tsx
  - packages/tui/src/planning.test.tsx
  - packages/tui/src/composer.tsx
  - packages/tui/src/question-dialog.ts
  - packages/tui/src/stream.ts
  - packages/tui/src/keys.ts
  - packages/tui/src/colour.tsx
  - packages/tui/src/home.tsx
  - packages/tui/src/app.tsx
  - packages/tui/src/queue.tsx
  - docs/design/tui-v2/screens/07-plan.txt
  - docs/design/tui-v2/keymap.json
  - docs/design/tui-v2/spec.md
  - docs/design/tui-v2/migration.md
  - docs/design/tui-v2/roles.json
  - docs/decisions/0009-tui.md
priority: high
type: feature
ordinal: 451000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want the planning session to read and type like Claude Code, with Enter to send, folded details, clean questions, rendered markdown and one conversation column, so that a planning session takes less effort than the Claude CLI does today, not more.

M6 (TUI v2). The maintainer's hand test of the planning session on 2026-11-10: "The whole view is not efficient yet. I want a more claude cli environment in the planning." What they found:

1. Ctrl+S to send is "a weird command". Enter sends; Shift+Enter makes a new line. Many terminals send the same byte for Shift+Enter as for Enter unless they are set up for it (Claude Code's `/terminal-setup` does that for some terminals). The maintainer uses Warp: the manual test records what Warp sends for Shift+Enter and whether it needs a Warp setting. A fallback that always works must exist: Option+Enter (ESC CR, with Option as Meta) and a trailing backslash before Enter, as Claude Code accepts. The maintainer asked for Cmd instead of Ctrl, but Warp keeps Cmd shortcuts for itself, so this story drops modifier shortcuts in the chat instead: Ctrl+S goes (Enter sends), and Ctrl+E (end session) becomes `/end` typed in the input.
2. Thinking and tool output take the space; the answer should show first. Thinking and tool lines fold to one line each by default and open on demand. The fold reuses the thinking fold of the Run stream (DIPO-461, packages/tui/src/stream.ts), not a second one (0001).
3. When Claude asks a question, raw JSON shows above it. The question and proposal blocks the engine reads (0022) never show as text in the conversation; only their rendered form does.
4. Questions need structure and colour: the question stands out, its options are a clear list with the recommended one marked, and the choices made are visible before sending and can be reviewed and changed.
5. Lines break wrongly in the question part. Every line wraps at the column width at word boundaries, with no broken or cut lines.
6. Claude's markdown shows raw. Headings, lists, bold, inline code and code blocks render, in the TUI's colour roles (roles.json, M6), with no new colours.
7. Layout: today the view is a centred script with a side rail and a boxed input (screens/07-plan.txt). It becomes one conversation column like Claude Code: your message, the answer, the folded details, and one input at the foot, with nothing else competing for space. The stories rail becomes a fold-out on Tab (IN THIS PLAN, DECISIONS, ON END with Y). Proposed stories show inline as compact cards (title, tier, first story line), with c (confirm), e (edit) and x (drop from plan) on a focused card and Y in the end preview, as keymap.json already names them. On main the view still uses modifier keys for these (packages/tui/src/planning.tsx:17-23 and packages/tui/src/keys.ts:525-549: Ctrl-Y confirm, Ctrl-D decline, Ctrl-R edit, Ctrl-G Ready); c, e, x and Y replace them. With an empty input, the up arrow moves focus into the conversation, the arrows move between folded lines and cards, Enter opens or folds the focused line, and typing returns to the input. This layout is the agent's recommendation; the maintainer approves the design wording in this story's PR.
8. "If I approved a proposal it doesn't go away in the planning session." On main `proposalLines` (packages/tui/src/planning.tsx:634-664) lists every proposal whatever its state, three rows ending at the selected one (:648), and only counts the open ones (:651); `stepSelection` (:99-108) moves over all of them, although only open and failed ones take a decision (`decidable`, :95-97). A proposal the maintainer confirmed leaves the open proposals at once and shows only as one compact line in the conversation: "filing…" while its state is `filing`, then "filed as DIPO-n" once `filed` (the ids from `stories`, packages/contract/src/work.ts:726-746). A declined one leaves too. Only proposals that still need a decision (open, and failed with the lane's reason) stay as cards and take the selection.
9. Keys (the maintainer, 2026-11-10): planning becomes its own main view on key 5, beside 1 to 4, instead of P, and P no longer opens it. On main P is the planning key in `NAV_KEYS` (packages/tui/src/keys.ts:883-889), the footer entry `plan` (keys.ts:780), the overlay exits (`leavesOverlay`, packages/tui/src/home.tsx:166-169) and the app's key handler (packages/tui/src/app.tsx:301). The Retro's "discuss in a plan" (keymap.json `discussPlan`, key P) moves to d in the Retro, the first letter of its label and free there. In the Queue, run now moves from R to r (keymap.json `runNow`, keys.ts:718 `queueRun`); r is free in the Queue, and r on the Desk stays resume and retry.

Design files change to match: docs/design/tui-v2/screens/07-plan.txt, keymap.json (the plan entries, the Plan view's send and new-line keys, planEnd, plan, discussPlan, runNow), spec.md (the Plan section, and a note that the text mock wins over the HTML's mock 11) and migration.md. ADR 0009 lines that change: section 3's first line ("Rooms are numbered 1 to 4 ... P opens planning"), which becomes rooms 1 to 5 with Plan on 5; the Planning line ("**Planning** (P) ... shows ... the streamed answers, takes multi-line messages, shows Claude's question blocks as a dialog"), which gets key 5, the conversation column, Enter to send and folded details; section 4's actions table row "R | work.run", which becomes r; and the Global keys line ("1 to 4, P, O, ..."), which becomes 1 to 5 and O. One line in its Replaced list names the centred script with side rail, Ctrl+S and P for planning. The other Composer prompts (steer, answer, note, top-up) are not part of this story.

Tier L: it changes input, output and layout of one view. If it runs over, split it into input (criteria 1, 2) and output, layout and keys (criteria 3 to 12).

```dipo
branch: "DIPO-479/planning-like-claude-code"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) in the Plan input, CR sends; ESC CR, a trailing backslash before CR, and the Shift+Enter sequences CSI 13;2u and CSI 27;2;13~ insert a new line; Ctrl+S no longer sends; /end opens the end preview"
    - kind: "automated"
      check: "(unit) over a fixture answer with thinking, tool lines and text, thinking and tool lines render folded to one line each, the answer text first, and Enter on a focused fold opens and folds it again"
    - kind: "automated"
      check: "(unit) an answer that ends in a question block renders the question view only, with no JSON or fence text on screen; the same for a proposal block"
    - kind: "automated"
      check: "(unit) the question view marks the question, lists the options with the recommended one marked, shows the chosen answers before sending, and lets a choice change before sending"
    - kind: "automated"
      check: "(unit) at 80 and 112 columns no rendered conversation or question line is wider than the column, and long words and option descriptions wrap at word boundaries"
    - kind: "automated"
      check: "(unit) markdown headings, lists, bold, inline code and code blocks render with colour roles from roles.json; a test fails on a colour not in roles.json"
    - kind: "automated"
      check: "(unit) the Plan view renders one conversation column and one input at the foot; Tab opens and closes the stories fold-out; a proposed story renders as an inline card where c, e and x act on the focused card, and Y in the end preview sets them Ready; Ctrl-Y, Ctrl-D, Ctrl-R and Ctrl-G do nothing there"
    - kind: "automated"
      check: "(unit) after c on a proposal, a view with it filing shows one 'filing…' line and no card, a view with it filed shows one 'filed as DIPO-n' line, a declined one shows no card, and the selection moves only over open and failed proposals"
    - kind: "automated"
      check: "(unit) 5 opens the Plan view from every room and overlay exit, P opens nothing, d in the Retro starts the discuss-in-a-plan session, r in the Queue sends work.run, R in the Queue does nothing, r on the Desk still resumes"
    - kind: "manual"
      check: "In Warp, open 5 on the scratch repository, type two lines with Shift+Enter, then with Option+Enter and with a trailing backslash, and send with Enter"
      expect: "Each way makes a new line and Enter sends; note what Warp sends for Shift+Enter and whether a Warp setting was needed"
    - kind: "manual"
      check: "In Warp, ask the planner something that makes it think, read files and then ask a question with options, next to screens/07-plan.txt"
      expect: "Thinking and tool lines are folded to one line each, the answer shows first, the question shows with no JSON above it, options are a clear list, lines wrap cleanly, markdown renders, and the screen matches 07-plan.txt"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 In the Plan view's input Enter sends and Shift+Enter makes a new line; Option+Enter and a trailing backslash before Enter always make a new line; Ctrl+S no longer sends there
- [ ] #2 Ctrl+E is replaced by /end typed in the input, which opens the end preview as Ctrl+E did; the Plan view has no other modifier shortcut
- [ ] #3 Thinking and tool output fold to one line each by default, the answer text shows first, and a folded line opens on demand without a modifier key, through the Run stream's fold (DIPO-461), not a second one
- [ ] #4 The question and proposal blocks the engine reads never show as raw JSON or fence text in the conversation; only their rendered form shows
- [ ] #5 A question renders with the question set apart, its options as a list with the recommended one marked, and the chosen answers visible and changeable before sending
- [ ] #6 Every line of the conversation and of the question view wraps at the column width at word boundaries, with no broken or cut lines
- [ ] #7 Claude's markdown (headings, lists, bold, inline code, code blocks) renders in the TUI's colour roles, with no new colours
- [ ] #8 The Plan view is one conversation column with one input at the foot; the stories rail is a fold-out on Tab; proposed stories show inline as compact cards where c, e and x work on the focused card, and Y in the end preview sets them Ready, replacing Ctrl-Y, Ctrl-D, Ctrl-R and Ctrl-G
- [ ] #9 A confirmed proposal leaves the open proposals at once and shows only as one compact line, 'filing…' and then 'filed as DIPO-n'; a declined one leaves too; only open and failed proposals stay as cards and take the selection
- [ ] #10 screens/07-plan.txt, keymap.json, spec.md and migration.md describe the new Plan view, and the view matches 07-plan.txt
- [ ] #11 Planning opens on key 5 as the fifth main view and P no longer opens it; the Retro's discuss in a plan moves from P to d; in the Queue run now moves from R to r, and r on the Desk is unchanged
- [ ] #12 ADR 0009's views line, Planning line, actions table and Global keys describe key 5, the conversation column, Enter to send, folded details and r for run now, with one Replaced line for the centred script, the side rail, Ctrl+S and P
<!-- AC:END -->
