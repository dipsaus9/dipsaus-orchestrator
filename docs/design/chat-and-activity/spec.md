# Chat, background and focus: spec (addendum to TUI v2)

Base: `docs/design/tui-v2/` on `origin/main` as of ebde2136 (2026-11-27), its 30 maintainer decisions included. Everything there holds unless a numbered proposal below changes it. Each proposal needs the maintainer's yes before its story is made Ready; P2 changes an ADR and needs explicit approval (CLAUDE.md, Rules).

## What the chat is for
The chat stops being a planning tool. It becomes dipo's voice in the office: the one place you talk to dipo about whatever is in front of you.

- **It explains.** Why a story waits, why a run loops, why CI is red, what a change does, what something cost. It reads the same facts the rooms show, and answers with file and line.
- **It helps you decide.** On a merge, a question, a park or a proposal it tells you what the choice means and what it unblocks, and can draft the answer, the note or the top-up for you.
- **It helps you fix.** On a failing run or check it reads the stream, verify and CI output and proposes a steer, a resume with a note, or a fix story.
- **It plans.** Everything the Plan view does today: refine, split and file stories, edit dependencies, take them through the Ready step.
- **It improves the process.** In Retro and Roles it reads the numbers and the role files and proposes changes to stories, roles and preferences.

What it is not:
- **Not an actor.** It never sends a command. Every action is a card you confirm with `c`, sent as your own command; drop and discard stay behind their prompts.
- **Not a second dashboard.** State lives in the rooms; the chat explains it and never repeats it as a feed.
- **Not a replacement for keys.** Every verb keeps its key in the room. The chat adds a way to understand, not a second way to act.
- **Not a guesser.** It answers from code-built facts and the repository, says when it does not know, and gives no estimated times (decision 24).

By room, what it is for: Desk, decide; Floor and Run, understand and fix; Queue, get stories Ready and in order; story reader, judge a review; Retro, the process; Roles, the roles; a background item, why it broke.

## Reading the screen files
Exactly as `tui-v2/spec.md`, "Reading the screen files": a caption `=== <title> · <cols> cols × <rows> rows ===`, then that many rows, cell for cell; `[role]…[/]` from `tui-v2/roles.json`; `**bold**`, `__underline__` (in acc); `[sel]…[/]` is the focused row's background over the cells it wraps; an unmarked `│` or full-width `─` is faint; `--- notes ---` ends the screen. `test/support/mock-screens.ts` reads these files as they are (caption regex ` (\d+) rows ===`). New screens live in `screens/` here; the ones they change in `tui-v2/screens/` are named in each caption and note.

| File | Shows | Changes |
|---|---|---|
| `01-queue-with-dock.txt` | the strip grown to a dock after `` ` `` (too narrow for the panel), a command card | adds to `05-queue.txt` |
| `02-chat-room.txt` | Chat full screen on `5` | changes `07-plan.txt` (head lines, context dividers, `/` commands) |
| `03-floor-background.txt` | BACKGROUND group, header chip, chat line | changes `02-floor.txt` (BACKLOG row becomes a BACKGROUND row) |
| `04-background-detail.txt` | ⏎ on a failed story PR: checks and log tail | new |
| `05-run-with-dock-wide.txt` | the chat panel with the keyboard (152+ columns), a steer card | adds to `03-run.txt` |
| `06-desk-jump-and-line.txt` | `! N for you`, a question, `Ask dipo first` | adds to `01-desk.txt` |
| `07-states.txt` | chat line states, queued input, context line, card results, refusals, offline, header chips | new |
| `08-desk-chat-panel.txt` | the chat panel on (154+ columns), keyboard in the room, `ask about this` | adds to `01-desk.txt` |
| `09-queue-chat-strip.txt` | the chat strip (the Queue below 168 columns), keyboard in the room | adds to `05-queue.txt` |
| `10-queue-now.txt` | Queue `now`: only what can start | changes `05-queue.txt` |
| `11-queue-plan.txt` | Queue `plan`: open stories by milestone, a milestone preview | new |

## Proposals for the maintainer
- **P1 · The chat is always there.** It shows in every room as a panel or strip (P7), and `5` opens it full screen (today the Plan view, `07-plan.txt`, DIPO-487, same layout). The rooms row shows `5 Chat` with an acc count of answers you haven't seen. This changes tui-v2 "Plan view … is a document view in the Frame, not a room" in name and reach; the layout of 07-plan stays.
- **P2 · One standing chat per office, in threads (ADR 0024, amends 0022).** No session to start or refuse (`planning.open` goes). A thread is what a session is today (title, decisions, filed stories, record). `/new` starts one, `/end` closes it with today's Ready step, a day idle closes it. One Claude session answers at a time per office; a message sent meanwhile waits as `queued · sends when the answer ends`.
- **P3 · Context instead of kind.** Every message carries the room and the focused item; code builds the facts for that place (Desk item; Queue gate, chain, lists; Run phase, health, criteria, stream tail, verify/CI output, findings, budget; reader story and rounds; Retro numbers; Roles roster; Background item and log tail). The kinds stay as record values. Retro's `d` and the Roles room's `c` keep their keys and open the dock with that context.
- **P4 · Action cards.** Besides story and role proposals, an answer may carry `steer`, `answer`, `resume`, `ready` and `command` cards. `c` sends the maintainer's own command (`origin: "chat"`); the card shows `◌ …ing…`, then `✓` or `✗ … ^R` in place (`07-states.txt`). Drop and discard are only `command` cards (`c` copies the line) or `X`/`D` opening the existing prompts.
- **P5 · BACKGROUND replaces BACKLOG on the Floor**, fed by a new engine list `OfficeSnapshot.background` (story PRs after the run, the backlog PR, open tests, the audit, the chat, the daemon's own work). Header chips `◌ N in background` / `✗ N failed in background`.
- **P6 · Focus keys.** `` ` `` gives the chat the keyboard (and shows it if hidden); `esc` gives it back to the room. `\` shows or hides the chat (remembered per viewer). `!` goes to the next thing for you (the header shows `! N for you`), `'` back to where you were before the last jump or link. All are symbols and open tools, per the keymap rule; the room keeps every lowercase key.
- **P7 · Visible is not focused; the chat is a toggle.** The chat is on by default and `\` toggles it; the setting is remembered. It never takes the keyboard by itself: while the room has it, the chat's input is dim (`> ` dim and `` ` to type``) and every key is the room's verb; with the keyboard the input is acc with a cursor and the footer shows the chat's keys.
  The panel is the right 56 columns and shows when the room keeps its own minimum width beside it; otherwise the strip shows. Minimum room widths: Desk, Floor, story reader and Roles 98; Run 96; Queue and Retro 112 (their mocks); so the panel needs 154, 152 or 168 columns. At about 180 columns every room has it.
  | Width | Chat on | Chat off |
  |---|---|---|
  | room minimum + 56 or more | the right 56 columns (`08-desk-chat-panel.txt`; with the keyboard `05-run-with-dock-wide.txt`) | the room has the full width; the chat line stays |
  | 100 up to that | a strip of two rows above the ticker: the latest answer's first line and the input (`09-queue-chat-strip.txt`); `` ` `` grows it to the dock (`01-queue-with-dock.txt`) | the chat line only |
  | below 100 | the chat line only; `` ` `` opens Chat full screen | the same |
- **P8 · The Queue gets two views,** `now` and `plan`, switched with `←→` (see Queue below).
- **P9 · The Retro room is built to 06-retro.txt,** with `d` handing the numbers to the chat (see Retro below).

## The chat
- **Layout** is 07-plan.txt's (DIPO-487, DIPO-491), in full screen and in the dock: your message a block (` > ` acc, shade background, a blank row before and after); each answer starts with ` ● ` acc, its fold line dim, its text indented 3; confirmed proposals one ok line each (`✓ filed as DIPO-519 · title`); cards with `▌` and sel when focused (first row from column 1, the rest from column 0 with five spaces, as 07-plan); the one-line input ` > ` at the foot.
- **Fixes to today's view** (DIPO-901): an answer row is never cut (rows wrap at the column width the indent leaves; no `truncate-end` on answer text); consecutive fold lines of one answer become one dim line (`·· read 2 files, grep 1 · 4.1s · 0.9k tokens`); lists inside answers use `·`, not `●`; a confirmed proposal shows once in the conversation (the rail keeps its own list); a refused command says why in words; the head rule is faint.
- **Context divider** `── in <room> · on <item> ──` (dim, indent 1) before the first message sent from a new place; never when the place is unchanged.
- **Context line** (dock only, the first row under its rule): dim `in <room> · on <item> · <state>` and, at the right, `/general asks without it` or `/here adds <item>`.
- **Keys**: `⏎` send, `shift-⏎` or `⌥⏎` new line (the Composer's rule), `↑` to the last card, `↑↓` over cards, `esc` to the input, then out of the dock; `tab` moves focus between the dock and the room. Slash commands: `/new`, `/end`, `/general`, `/here`, `/threads`.
- **Ask about this** (panel only): under the conversation, dim questions code builds from the focused item's kind (MERGE: what to test by hand, what merging unblocks, whether the advisory is worth a story). Nothing is sent until you pick one.
- **Chat line** (the chat off, or below 100 columns; the row above the ticker): ` > ` acc and dim `ask about <room> · <item>`; at the right dim `` ` chat`` (key acc). While dipo answers: ` ● ` acc, `dipo is answering about …` fg, dim tokens and time, `` ` watch``. An unseen answer adds `◆ 1 new answer in Chat` before it.

## Queue: two views (P8)
`←→` switches the Queue between two views, as Retro switches its period; `now  plan` sits at the right end of the rooms row (current one hi, underlined in acc). The Queue opens on `now`; the choice is remembered.
- **now** (`10-queue-now.txt`): only what can start: Ready stories whose dependencies are Done, in next-up order, the first marked `next up`. Under them `SLOTS` (from `office.summary`) and one dim line counting what is not shown (`2 waiting on a dependency · 3 not Ready yet`) with `→ plan view shows them by milestone`. The preview is 05-queue.txt's plus how the story starts. Footer `↑↓ move   r run now   p park   ⏎ story   ←→ view`, right `/ filter   ? keys`.
- **plan** (`11-queue-plan.txt`): every story that is not Done, grouped by milestone in the backlog's order. A milestone head is bold hi with a bar (Done over all, ok and faint, 14 cells) and `done/total`; a finished milestone folds to `✓ all N done`; at most four open stories show, `+ N more · ⏎ unfolds` folds the rest; stories without a milestone come last under `NO MILESTONE`. Rows are 05-queue.txt's (title padded to 30). ⏎ on a head folds it, on a story opens it. A milestone's preview: its description from the backlog, Progress, Ready, Not yet (why, in counts), Next (the first story to act on), its CHAIN and what blocks it. `space` and `Y` work on Refined rows as in 05-queue.txt. Footer `↑↓ move   ⏎ fold   space mark   Y set Ready   ←→ view`.
- The engine sends it all in a new read `office.milestones`: per milestone its id, title, description, counts by status, the open stories in chain order and the chain picture. The TUI groups and counts nothing itself.
- The chat's context in `plan` is the focused milestone (P3): "what's left for M5?" works without naming it.

## Retro (P9)
The Retro room is built as `tui-v2/screens/06-retro.txt` (S2c) says, which today's room does not do (DRAFT-21): the three headline numbers, BY TIER with the 2× median cells in err and the focused row on sel, the bars for WHY STORIES PARKED and WHERE STORIES CAME FROM, the period `7d  30d  all` on the rooms row (←→), `tab` for BY TIER and BY TYPE, ⏎ for the stories behind a row. `office.retro` returns these as data instead of text lines. `d` moves the keyboard to the chat with the Retro context (the numbers of the period on screen); the chat is where "what should we change?" is asked, and its answer may carry story, role or preference proposals. With the panel on, Retro needs 168 columns; below that the strip shows.

## The background
- **Row** (`03-floor-background.txt`): two-cell focus column, glyph and a space (`✗` err failed, `!` acc needs you, `◌` acc running, `○` acc waiting, `✓` ok done), the kind dim padded to 10 (`PR #698`, `PR #702`, `TEST`, `AUDIT`, `UPDATE`, `CHAT`), the subject (hi; err when failed; fg when done), the hint dim at the right with one trailing space (`⏎ checks`, `⏎ list`, `t resume`, `⏎ ideas`, or the time for a done row). Second row, dim, indented 14: the engine's `next` line. Order and text come from the engine; a done row stays 10 minutes. The group heading is bold hi `BACKGROUND` with the count dim at the right, a blank row after it.
- **⏎** opens the item at the Run's level (`04-background-detail.txt`): checks with the failing one's log tail for a PR, the lane's changes for the backlog PR (as BACKLOG's `⏎ list` today), the steps for a test (`10-test-overlay.txt`), the ideas for the audit.
- **Ticker** events for every background state change, with their time (as tui-v2: dim, `  ·  ` between).
- An item that needs the maintainer is also a Desk item, as today.

## Focus
- `!` visits, in order: Desk items in engine order, background failures, unseen chat answers. Each visit marks it seen. `'` returns to the place before the first `!` or the last link.
- Each room keeps its focused row, scroll and filter while the TUI runs; digits return there. Reopening the TUI restores the room, the dock and the draft.
- In an answer, story ids, PR numbers and `path:line` are links (acc). `tab` in the conversation cycles the links of the focused answer, `⏎` opens one at its level, `esc` or `'` returns with the draft kept.

## Header
Right to left: time, spend, the daemon dot and word, then the background chip, then `! N for you`, then `● plan open` (Desk only, while a thread waits on a Ready step); four spaces between; a chip with nothing to count is absent (`07-states.txt`, C6).
