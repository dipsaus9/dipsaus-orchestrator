# dipo TUI v2: design handoff

This folder is the design for the next dipo TUI. It was made from the TUI on `main` (packages/tui) and the contract (packages/contract/src/office.ts) as of 2026-11-06.

## Read in this order
0. `designs/dipo-ux-spec.html` and `designs/dipo-code-review.html`: the visual designs. Open them in a browser; they are self-contained and work offline. The text files below are the same designs in a form an agent can read.
1. `spec.md`: principles, information architecture, vocabulary, keymap, every screen and state.
2. `screens/`: each screen as a plain-text terminal mock at 112 columns. Role markup is `[role]text[/]`; see `roles.json`.
3. `keymap.json`: the action registry the footer, `?` overlay and palette all read from.
4. `migration.md`: seven steps from today's TUI to v2. Do them in order.
5. The seven steps are filed as M6 (`m-6`) stories in a backlog PR.

## Rules for whoever builds this
- The TUI renders what the engine computes. Never derive health, phase, desk order or skip reasons in the TUI.
- Lowercase keys act on the focused item. Capitals spend or destroy. Digits switch rooms. Symbols (`: / ? .`) open tools. There is no undo; only discard, drop, stopping a run and dismissing a setup issue ask to confirm.
- Color is never the only signal: every state has a glyph and a word. NO_COLOR and `--ascii` must read fully.
- Never truncate something the maintainer has to judge (story text, findings, questions). Lists may truncate; previews and readers wrap.
- Only touch engine or contract code for the four additions in `migration.md`: desk order with setup first (step 3), the since-you-last-looked summary in the office read (step 3), spend today in the office summary for the header (step 2), and an optional `consequence` on DeskAction (step 3).
- The screens must match `designs/dipo-ux-spec.html` exactly, except where the maintainer's decisions in `spec.md` say otherwise; there the text files win.
- Every step keeps `bun run verify` green and ships something visible.
