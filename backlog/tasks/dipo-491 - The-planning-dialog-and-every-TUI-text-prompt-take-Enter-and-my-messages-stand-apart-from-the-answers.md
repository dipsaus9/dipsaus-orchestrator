---
id: DIPO-491
title: 'The planning dialog and TUI prompts take Enter, and my messages stand apart'
status: In Progress
assignee: []
created_date: '2026-11-13 09:09'
updated_date: '2026-11-13 11:36'
labels:
  - 'tier:M'
milestone: m-3
dependencies:
  - DIPO-490
references:
  - packages/tui/src/question-dialog.ts
  - packages/tui/src/composer.tsx
  - packages/tui/src/composer.test.tsx
  - packages/tui/src/actions.ts
  - packages/tui/src/actions.test.ts
  - packages/tui/src/steering.ts
  - packages/tui/src/transcript.ts
  - packages/tui/src/transcript.test.ts
  - packages/tui/src/planning.tsx
  - packages/tui/src/planning.test.tsx
  - packages/tui/src/keys.ts
  - packages/tui/src/footer.test.ts
  - docs/design/tui-v2/keymap.json
  - docs/design/tui-v2/spec.md
  - docs/design/tui-v2/roles.json
  - docs/decisions/0009-tui.md
priority: high
type: bug
ordinal: 463000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want the planning view's question dialog and every text prompt of the TUI to take Enter as the main key, and my messages to stand apart from the answers, so that answering and reading a planning session works like Claude Code and is no longer tiring.

M3 (0022), a bug from the maintainer's M4 planning hand test on 2026-11-12. DIPO-479 made Enter send in the planning input; three findings remain.

1. The question dialog still sends with Ctrl-S and leaves with Ctrl-N (packages/tui/src/question-dialog.ts:131-137, its header :1-8; the footer entries `dialogSend` and `dialogLeave`, packages/tui/src/keys.ts:649-690). The maintainer: "It is still annoying to use ctrl s to send in the list / options view". Wanted: Enter (or the row's digit) on an option picks it and moves to the next unanswered question; after the last question a final "Submit" row lists every answer, and Enter on it sends `planning.answer`; Left and Right still go back to change an answer; Esc while choosing leaves the block unanswered, as Ctrl-N did. On the free-text row Enter opens the text and Enter again takes it, as today; Esc while typing goes back to the options, as today.
2. The Composer outside planning keeps the opposite keys: Enter adds a line and Ctrl-S sends (`composerKey` and `editDraft`, packages/tui/src/composer.tsx:1-4, :28-36, :66-77). It serves the desk's text prompts (answer, park and reject notes; packages/tui/src/actions.ts:5, :713-714, hints :861), the top-up prompt of a resume, whose first Ctrl-S shows the caps and second sends it confirmed (actions.ts:17-20, :669-690, hints :862-866), and the Run's steer (packages/tui/src/steering.ts:1-4, :71). Wanted: the planning input's keys everywhere: Enter sends; Option+Enter, a trailing backslash before Enter and, where the terminal sends it, kitty's Shift+Enter add a line; Esc cancels. On the top-up prompt the first Enter shows the caps and the next sends it confirmed. The `enterSends` switch (composer.tsx:49-71) goes, as there is one key set left.
3. Messages blend with answers: the maintainer's message is a coloured `you> ` prefix on lines straight under the previous answer (`textRows`, packages/tui/src/transcript.ts:96-115), and an answer has no marker, so "you> confirmed right?" sat directly under the last answer and above a dim "thinking 1.6s" line. Wanted, as Claude Code shows it: a blank line before and after each maintainer message, which shows as its own block, a `>` prefix on the background of an existing role, `shade` (docs/design/tui-v2/roles.json, no new colour; under NO_COLOR the prefix and the blank lines still mark it); each answer starts with a `●` marker on its first line (an ASCII fallback through `glyphs`, as the other markers have); its thinking and tool fold lines sit under that marker, indented and dim.

Replaces: Ctrl-S and Ctrl-N in the question dialog, Enter-for-a-new-line and Ctrl-S in the Composer (and the `enterSends` switch), and the `you> ` prefix line style.

Needs DIPO-490: that story moves the maintainer's messages from the TUI-only `you>` lines into the engine's view and rewrites the same transcript code (`useTranscript` in planning.tsx, `transcript.ts`); restyling them first would be done twice and conflict.

Not a guard: no deny rule, sandbox setting or permission check changes (R30 does not apply).

ADR 0009 section 3, the **Planning** line (line 50): "shows Claude's question blocks as a dialog" gains its keys (Enter picks and moves on, a Submit row sends, Left and Right change an answer, Esc leaves it unanswered), and the input part names how a maintainer message and an answer show. ADR 0009's Replaced list gains one line: Ctrl-S and Ctrl-N in the question dialog and Enter for a new line and Ctrl-S to send in the Composer (2026-11-12), replaced by Enter, the Submit row and Esc. The footer hints come from the key registry (`FOOTER_KEYS` in keys.ts, and the prompt hints in actions.ts), and docs/design/tui-v2/keymap.json (`composerNewLine`, `composerSend`, :922-939) and spec.md (:114) show the new keys.

Tier M: one dialog's keys, one Composer key set for four callers, a transcript style and the hints.

```dipo
branch: "DIPO-491/enter-keys-and-message-style"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) in a two-question dialog, Enter on an option picks it and moves to question 2; Enter there moves to the Submit row, which lists both answers; Enter on Submit sends planning.answer; Left goes back and a changed answer shows on Submit; Ctrl-S and Ctrl-N do nothing"
    - kind: "automated"
      check: "(unit) Esc while choosing leaves the block unanswered (the dismiss Ctrl-N did); on the free-text row Enter opens the text, Enter takes it, and Esc while typing returns to the options"
    - kind: "automated"
      check: "(unit) the Composer for a desk answer, a park note and a steer: CR sends; ESC CR, a trailing backslash before CR and CSI 13;2u add a line; Ctrl-S does nothing; Esc cancels"
    - kind: "automated"
      check: "(unit, actions) on the top-up prompt the first Enter sends work.resume unconfirmed and shows the caps, the next Enter sends it confirmed, and a changed share asks for the caps again"
    - kind: "automated"
      check: "(unit, transcript) a maintainer message renders with a blank row before and after, a '>' prefix and the shade background role; an answer's first row starts with '●' and its fold rows follow it indented and dim"
    - kind: "automated"
      check: "(unit, footer) the dialog, Composer and top-up hints list Enter and Esc from the registry and name no ctrl- key; keymap.json holds the same keys"
    - kind: "manual"
      check: "In Warp, in a planning session, answer a two-question block with Enter only, change one answer with Left, send from Submit; then answer a desk question, steer a run and top up a resume with Enter"
      expect: "No Ctrl key is needed anywhere; each message of yours shows as its own block with a blank line around it and each answer starts with ●"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 In the question dialog Enter on an option picks it and moves to the next unanswered question, a final Submit row lists every answer and Enter on it sends planning.answer, and Left and Right still change an answer
- [ ] #2 Esc while choosing leaves the block unanswered; the free-text row keeps Enter to open and to take the text; Ctrl-S and Ctrl-N no longer act in the dialog
- [ ] #3 Every Composer prompt (desk answer and notes, steer, top-up note) sends on Enter and adds a line on Option+Enter, a trailing backslash or kitty Shift+Enter; Esc cancels; Ctrl-S no longer sends; the enterSends switch is gone
- [ ] #4 On the top-up prompt the first Enter shows the caps and the next sends the resume confirmed
- [ ] #5 A maintainer message shows as its own block with a blank line before and after and a > prefix on an existing role's background; each answer starts with a ● marker with its fold lines under it, dim
- [ ] #6 The footer and prompt hints, keymap.json and spec.md show the new keys, and a test checks the hints name no ctrl- key
- [ ] #7 ADR 0009's Planning line names the dialog keys and the message style, with one Replaced line for Ctrl-S and Ctrl-N in the dialog and the Composer
<!-- AC:END -->
