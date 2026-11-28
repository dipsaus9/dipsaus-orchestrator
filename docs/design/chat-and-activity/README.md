# dipo: one chat, the background and focus — design addendum to TUI v2

Base: `docs/design/tui-v2/` on `origin/main` (ebde2136, 2026-11-27), with its 30 maintainer decisions. This addendum changes nothing there until the maintainer says yes to its proposals (`spec.md`, P1 to P7); P2 changes ADR 0022 and needs explicit approval.

## The shift
The chat is no longer for planning only. It is dipo's voice in the office: always there (a panel, a strip or a line, depending on the width; `\` hides it), aware of the room and item you are on, and there to explain, help you decide, help you fix, plan and improve the process. It never acts on its own: every action is a card you confirm. `spec.md`, "What the chat is for", is the statement every story builds against.

## How dipo builds it pixel perfect
1. **DIPO-900 first.** It makes every caption in `tui-v2/screens/` and `chat-and-activity/screens/` a whole-frame test: characters, roles, bold, underline and the focus background, header to footer. A builder cannot merge a screen that differs from its mock in one cell; the reviewer checks against the same test.
2. **DIPO-910** closes the gaps the shipped TUI has to the TUI v2 mocks today (footers, ⏎ hints, unfaded rules, Frame height, ticker, story reader head, missing keys).
3. **DIPO-911** builds the Retro room to `tui-v2/screens/06-retro.txt`; **DIPO-912** gives the Queue its `now` and `plan` views.
4. Then the addendum's tracks, each story naming the mock captions it must pass.

The mocks win over the code. Where a story finds the mock wrong, it changes the mock in the same PR and says so.

## Files
- `spec.md`: the proposals, the chat, the background, focus, the header.
- `screens/`: eleven files, cell for cell in the tui-v2 markup (`[role]…[/]`, `**bold**`, `__underline__` in acc, `[sel]`, a caption with `cols × rows`, `--- notes ---`). `test/support/mock-screens.ts` reads them as they are.
- `keymap-additions.json`: the new keys in `keymap.json`'s schema.
- `migration.md`: order, tracks, contract additions.
- `backlog/`: DIPO-900 to 910 as Backlog.md drafts with field blocks and test plans. The ids are placeholders: renumber, set milestones and file them with the Backlog CLI in a backlog PR.

## Rules carried over
- The TUI renders what the engine computes; the background list, its order and its `next` lines come from the engine.
- Lowercase acts on the focused item. Capitals spend or destroy. Digits switch rooms. Symbols open tools (`` ` `` and `!` are new). There is no undo. No expected times.
- Never truncate something the maintainer has to judge.
- Colour is never the only signal.

## Before a Claude session builds from this
1. **Pull `main` first.** The local checkout is 158 commits behind `origin/main`, and its untracked `docs/design/tui-v2/` is an old copy (14 of 18 files differ, 4 screens missing). `git pull` refuses while those untracked files sit where the tracked ones go: move the old copy aside first (`mv docs/design/tui-v2 docs/design/tui-v2.local-old`), pull, then compare and remove it.
2. **File the stories with the Backlog CLI** in one backlog PR (CLAUDE.md: never by hand when the CLI can): renumber DIPO-900 to 912, keep the field blocks as they are, archive DRAFT-21 when DIPO-911 is filed. Every draft passes the file-only gate rules (R02, R04 to R12, R16 to R18, R20, R22, R23, R26, R32); R15 still blocks Ready on the open unknowns, which are the maintainer's decisions (900, 903, 910, 912).
3. **Commit this folder** in that PR, so a worker's box (a copy of the base branch) can read it.
4. **Add one line to CLAUDE.md, Status**, next to M6: "the chat, background and Queue views are designed in `docs/design/chat-and-activity/` (proposals P1 to P9 in its spec.md)".
