# dipo: one chat, the background and focus — design addendum to TUI v2

Base: `docs/design/tui-v2/` on `origin/main` (ebde2136, 2026-11-27), with its 30 maintainer decisions. The maintainer said yes to its proposals (`spec.md`, P1 to P9) in the planning session of 2026-11-28, P1 with one change (the rooms row keeps its four rooms), and explicitly approved P2's change to ADR 0022, which DIPO-522 writes. The tui-v2 files changed where an answer required it: the underline takes the text's colour, and M6's engine additions list the four this addendum adds.

## The shift
The chat is no longer for planning only. It is dipo's voice in the office: always there (a panel, a strip or a line, depending on the width; `\` hides it), aware of the room and item you are on, and there to explain, help you decide, help you fix, plan and improve the process. It never acts on its own: every action is a card you confirm. `spec.md`, "What the chat is for", is the statement every story builds against.

## How dipo builds it pixel perfect
1. **DIPO-520 first.** It makes every caption in `tui-v2/screens/` and `chat-and-activity/screens/` a whole-frame test: characters, roles, bold, underline and the focus background, header to footer. A builder cannot merge a screen that differs from its mock in one cell; the reviewer checks against the same test.
2. **DIPO-530** closes the gaps the shipped TUI has to the TUI v2 mocks today (footers, ⏎ hints, unfaded rules, Frame height, ticker, story reader head, missing keys).
3. **DIPO-531** builds the Retro room to `tui-v2/screens/06-retro.txt`; **DIPO-532** gives the Queue its `now` and `plan` views.
4. Then the addendum's tracks, each story naming the mock captions it must pass.

The mocks win over the code. Where a story finds the mock wrong, it changes the mock in the same PR and says so.

## Files
- `spec.md`: the proposals, the chat, the background, focus, the header.
- `screens/`: eleven files, cell for cell in the tui-v2 markup (`[role]…[/]`, `**bold**`, `__underline__` in the text's colour, `[sel]`, a caption with `cols × rows`, `--- notes ---`). `test/support/mock-screens.ts` reads them as they are.
- `keymap-additions.json`: the new keys in `keymap.json`'s schema.
- `migration.md`: order, tracks, contract additions.
- The stories: DIPO-520 to DIPO-532, filed with the Backlog CLI on 2026-11-28 in `backlog/tasks/` (the drafts this folder held are gone; Backlog is the source of truth).

## Rules carried over
- The TUI renders what the engine computes; the background list, its order and its `next` lines come from the engine.
- Lowercase acts on the focused item. Capitals spend or destroy. Digits switch rooms. Symbols open tools (`` ` `` and `!` are new). There is no undo. No expected times.
- Never truncate something the maintainer has to judge.
- Colour is never the only signal.

## Filed
The stories DIPO-520 to DIPO-532 were filed with the Backlog CLI in one backlog PR on 2026-11-28, from the planning session that answered the proposals and the open unknowns; DRAFT-21 is archived with a pointer to DIPO-531. CLAUDE.md's Status points here.
