# dipo TUI v2: design handoff

This folder is the design for the next dipo TUI. It was made from the TUI on `main` (packages/tui) and the contract (packages/contract/src/office.ts) as of 2026-11-06.

## Read in this order
1. `spec.md`: principles, information architecture, vocabulary, keymap, every screen and state.
2. `screens/`: each screen as a plain-text terminal mock at 112 columns. Role markup is `[role]text[/]`; see `roles.json`.
3. `keymap.json`: the action registry the footer, `?` overlay and palette all read from.
4. `migration.md`: seven steps from today's TUI to v2. Do them in order.
5. The same seven steps are Backlog.md stories on milestone M6 (`m-6`).

## Rules for whoever builds this
- The TUI renders what the engine computes. Never derive health, phase, desk order or skip reasons in the TUI.
- Lowercase keys act on the focused item and are safe or undoable. Capitals spend or destroy. Digits switch rooms. Symbols (`: / ? .`) open tools.
- Color is never the only signal: every state has a glyph and a word. NO_COLOR and `--ascii` must read fully.
- Never truncate something the maintainer has to judge (story text, findings, questions). Lists may truncate; previews and readers wrap.
- Only touch engine or contract code for the two additions in `migration.md` (spend in the office summary for the header, and an optional `consequence` on DeskAction).
- Every step keeps `bun run verify` green and ships something visible.
