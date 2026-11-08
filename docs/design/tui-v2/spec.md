# dipo TUI v2: spec

The screens must match `docs/design/tui-v2/designs/dipo-ux-spec.html` exactly. The text mocks in `screens/` are the same screens in text. The ux-spec wins over `designs/dipo-code-review.html` and over these files, except where the maintainer's decisions below say otherwise: there the text files win. Where the ux-spec says nothing, the code review stands.

## Job
Make the maintainer's decisions obvious, and keep everything else quiet but reachable.

## Reading the screen files
- Each mock starts with a caption line `=== <title> · ux-spec mock <n> · <cols> cols × <rows> rows ===`. The next `<rows>` lines are the screen, cell for cell: one character is one terminal cell, spaces included, blank rows included. A line `--- notes ---` starts notes that are not part of the screen.
- `[role]text[/]` paints text in a role from `roles.json`. Roles nest; `[/]` closes the innermost one.
- `**text**` is bold and `__text__` is underlined (always in acc). Both sit inside the role.
- `[sel]…[/]` is the focused row's background; it covers the cells it wraps, padding included.
- An unmarked `│` or full-width `─` is a pane rule in faint. A box (`┌─┐ │ └─┘`) carries its border role on every border cell.
- `⟦ key Label ⟧` is a clickable button: `[acc]⟦[/]…[acc]⟧[/]` is the primary button (acc border), `[faint]⟦[/]…[faint]⟧[/]` the others.
- A 1px border is one cell. Fixed-height mocks are padded to their rows; the list and preview panes stretch to the body height, so their `│` runs down to the ticker.
- Overlays are drawn into the screen behind them: centred, top edge on row 2, the rows behind in shade.
- Widths: full screens are 112 columns (S6 narrow: 80). The S1c previews are the Desk's right pane, 63 columns. The S10 theme cards are drawn at 80. The S6 to S8 state cards are drawn at 112.
- Where the screens differ from the HTML: the decisions below changed some mocks (each change is listed there). Beyond that, three things have no exact text form:
  - Two dim lines are single unwrapped lines in the HTML that run past their pane: mock 1's "Accepting files it as a Backlog draft. You refine it in a planning session." and mock 4's "A fresh session starts with a handoff. The box and branch are kept." The text wraps them at the pane width.
  - Sub-line gaps (0.3 to 0.6 of a line) between rows, the underline offset and the rounded corners have no terminal form and are dropped.
  - The HTML draws the S1c, S6 to S8 and S10 cards in fluid columns whose width depends on the browser window; the text fixes them at the widths above.

| File | ux-spec |
|---|---|
| `01-desk.txt` | S1b, mock 2 (changed: decisions 1, 2, 13, 24) |
| `02-floor.txt` | S2, mock 8 (changed: 9, 24) |
| `03-run.txt` | S3, mock 13 (changed: 18); S7 steer, mock 21 |
| `04-story-reader.txt` | S4, mock 14 |
| `05-queue.txt` | S2b, mock 9 |
| `06-retro.txt` | S2c, mock 10 (changed: 26) |
| `07-plan.txt` | S2d, mock 11 |
| `08-offices.txt` | S2e, mock 12 (changed: 4, 16) |
| `09-palette.txt` | S5, mock 15 (changed: 3, 9, 10, 20) |
| `10-test-overlay.txt` | S1d, mock 7 (changed: 15) |
| `11-desk-previews.txt` | S1c, mocks 3 to 6 (changed: 24) |
| `12-states.txt` | S6 mocks 16, 17; S8 mocks 25, 26; S7 mocks 22 to 24 (changed: 4, 18, 23, 24) |
| `13-keys-overlay.txt` | S9, mock 27 (changed: 6) |
| `14-desk-proposals.txt` | S1, mock 1 (changed: 12, 27, 28) |
| `15-budget-and-failed.txt` | S6, mocks 18, 19 (changed: 8, 17) |
| `16-narrow.txt` | S6 at 80 × 24, mock 20 (changed: 14, 27) |
| `17-themes.txt` | S10, mocks 28 to 31 |

## Principles
1. **Needs-you first.** The number that matters is how many decisions wait for you. It sits in the header of every screen, and dipo opens on the Desk whenever it's above zero.
2. **One verb, one key.** A key means the same thing on every screen. The footer only shows the verbs for the item in focus.
3. **Quiet by default.** Scheduler chatter shrinks to a one-line ticker. Totals live in Retro. A reason lives where you'd look for it: the Queue explains why a story waits.
4. **Show the pipeline.** Every story sits somewhere on `setup ━━ build ━━ review ━━ test ━━ merge`, the engine's `KNOWN_PHASES`, on every screen. Verify and CI are ✓/✗ marks inside a phase, not phases. Finished phases are ok, the current one is `● name` in acc, future ones are faint and dotted (`┄┄`). The same line appears on the Floor, in the Queue, the Story, the Run and the Desk preview.
5. **Never truncate a decision.** Lists can use `…`. Anything you judge (story text, findings, questions) wraps in full in a preview or reader pane.

## Information architecture
Three levels and four rooms. Drill down with ⏎ and climb back with esc. Overlays sit above every level.
- **Offices** (`O`, one per product repo) → **Office** with four rooms → **Story** (⏎: story · criteria · reviews · runs) → **Run** (⏎ on a running story: live stream, steer, park). The ux-spec's IA diagram labels Offices `o`; it is `O`.
- Rooms: **1 Desk** (needs you, `office.desk`), **2 Floor** (running, in review), **3 Queue** (ready, waiting), **4 Retro** (done, cost; DIPO-453).
- **Plan view** (`P` from anywhere, DIPO-447 to 452) is a document view in the Frame, not a room. Esc leaves it open, the Desk header shows `● plan open` at the right while it is open (`01-desk.txt`), and reopening the TUI goes straight back to it.
- Overlays: `:` or `ctrl-k` the command palette (everything is reachable there), `?` every key for this screen, `/` filter the list in focus, `t` the test overlay, and the Composer prompts.
- **Launch rule.** Inside a repo, `dipo` opens that office: on the Desk if anything needs you, otherwise on the Floor. Outside a repo it opens Offices. Quitting the TUI never stops the daemon, and the first quit of a session says so once.

## Vocabulary
Keep the office metaphor; every word is a place or a person.

| Today | Becomes | Why |
|---|---|---|
| [1] overview | Floor | The place where work happens. |
| Your desk | Desk | Only things that wait for you. Room 1. |
| PROFILE | Setup issue | Something in config blocks the office. The Desk group header reads `SETUP`. |
| skipped …: dependency not Done | Waiting on DIPO-447 | Previews and the reader say "Waiting on DIPO-447". Lists (the Queue) say `needs 447✗` (parked) or `needs 452→` (moving). |
| run next Ready story: done | ticker event | One dim line above the footer, then gone. |
| since you left: … | Since 09:41 | A summary band you dismiss with any key. |
| [4] checklist | open question | The test overlay, opened by `t` (S1d). |

Engine words the screens use as they are (code review): lifecycle Refined → Ready → In Progress → In Review → Done, any of them → Parked → back; Parked is the only waiting state; discard returns a story to Refined and drop archives it. Health: busy · quiet · stuck · looping · lost. Park reasons: ambiguous-spec · budget-exceeded · verify-failing · conflict · review-blocked · scope-violation · worker-failed · by-maintainer.

## The frame
Every screen uses the same five bands.
```
header   dipo / <office>   +2 elsewhere · O                 ● daemon live    $19.14 today    10:42
rooms    1 Desk 3    2 Floor 2    3 Queue 0·6    4 Retro
────────────────────────────────────────────────────────────────────────────────────────────
body     list (46 cols) │  preview                 (≥ 100 cols; the Since band sits above it)
ticker   10:41 merged DIPO-444  ·  10:40 DIPO-447 → merge  ·  …   (dim, one line)
────────────────────────────────────────────────────────────────────────────────────────────
keys     verbs for the focused item (left)                               : commands   ? keys
```
- **Header**: `dipo` in acc and bold, ` / ` dim, then the office (fg). When other offices need you, right after the office name: three dim spaces, `+2` acc, ` elsewhere · ` dim, `O` acc, from `office.summary` (`14-desk-proposals.txt`). Right: on the Desk while a planning session is open, `●` acc and ` plan open` fg, four spaces; then `●` ok, ` daemon live` fg, then dim `    $19.14 today    10:42`. Deeper levels extend the path in dim (`dipo / dipsaus-orchestrator / Floor / ` then `DIPO-447` in fg) and show `● live` and the time. Plan shows `● planner live` and `$0.84 this session`. Offices shows `$27.10 today, all offices`.
- **Rooms**: gap of 4 spaces (3 at 80 columns). The current room is hi with an acc underline; the others are dim. Desk's count is acc. Queue shows `ready·waiting` (`0·6`); at 80 columns it shows `3 Queue` without counts. Retro has no count; on Retro the period switch `7d  30d  all` sits at the right end of the rooms row.
- **Since band** (Desk, 100 columns or wider): dim `Since 09:41 · ` then `1 merged` in fg, dim ` · 2 new proposals · $4.10 spent`, and `any key to dismiss` at the right, between two rules. Its data is an engine addition: "since you last looked" in the office read (step 3).
- **Body**: list on the left (46 columns on the Desk, 62 on the Queue, 57 on Retro, 28 on the Run), `│` in faint, two spaces, then the preview.
- **Ticker**: the latest events, dim, `  ·  ` between them.
- **Keys**: verbs for the focused item on the left (key in acc, label in fg, 3 spaces apart); global keys on the right, labels dim (`: commands   ? keys`, or `esc back   ? keys`, `/ filter   ? keys`, `esc back   q q quit`).
- Mouse (SGR 1006): click focuses a row, double-click is ⏎, the wheel scrolls the pane under the cursor, and clicking a room or a key hint triggers it.

### Widths
- 100 columns or more: split panes.
- 60 to 99 columns: single pane, ⏎ opens the preview full screen. Each list row keeps its most important secondary line. The ticker and the Since line drop out. The header shortens the office name (`dipsaus-orch…`) before it drops the daemon dot. See `16-narrow.txt`.
- Below 60 columns, or below 16 rows: dipo shows "Widen the terminal to at least 60 columns" instead of a broken layout.
- Read the width from `useStdout().columns`.

## Desk (S1, S1b, S1c)
Files: `14-desk-proposals.txt`, `01-desk.txt`, `11-desk-previews.txt`.
- **Heading**: bold hi `NEEDS YOU`, the count in acc at the right of the list, then a blank row.
- **Groups.** One dim header per kind, rows under it, a blank row between groups. Setup issues come first, then the rest in the engine's order. The engine sets the whole order: `KNOWN_DESK_KINDS` changes so the setup kinds (PROFILE) come first, then STARTS PAUSED, QUESTION, SCOPE, MERGE, PARKED, PR HEAD CHANGED, DONE ELSEWHERE, LEFTOVERS, BACKLOG PR, PLANNING LANE, NOTICE, PROPOSED STORY, DECISION NOTE, NEXT UP, PARKED BY YOU, LOADING (an engine addition in step 3). Within a group the engine puts the most-blocking item first, then the oldest. The TUI never re-sorts.
- **Group names**: PROFILE reads `SETUP`, PROPOSED STORY reads `PROPOSALS · from your AI team` (`PROPOSALS` at 80 columns); the other kinds keep the engine's name.
- **Row**: two-cell focus column (`▌` in acc when focused), the kind glyph in its role plus a space, the title (hi when focused), the age right-aligned in dim with two trailing spaces. Second row, dim, indented 4: the reason, plus `blocks N` when it holds others up. The focused item's two rows are on sel.
- **Kind glyphs**: `!` paused (acc), `?` question (acc), `○` waiting gate (acc), `✗` parked or setup issue (err), `◆` proposal (acc), `→` next up (ok). They stay readable under NO_COLOR.
- **Duplicates**: no display grouping; each proposal the engine sends is one row.
- **Preview** (from `DeskItem`: `detail`, `blocks`, `since`, `hand`, `actions`): dim `KIND · why` line, the bold hi title, the pipeline line for a story, the full text (wrapped at 60 columns), then dim labels padded to 8 (`Why`, `Blocks`, `Size`, `Raised`, `Review`, `CI`, `Change`, `Tests`, `Tier`, `Shares`, `Reason`, `Lifts`, `Running`, `Parked`). Then the buttons for the bound actions, 2 spaces apart, the first one primary. Then the dim consequence line (`DeskAction.consequence`, an engine addition in step 3) and the dim `$ dipo …` cli line, so the TUI teaches the CLI. A story that waits on another says "Waiting on DIPO-447".
- **Verbs live once**: as buttons in the preview and keys in the footer, never on each row. Buttons are clickable.
- **After acting**, focus moves to the next item.
- `y` means what the item asks: approve on MERGE, accept on PROPOSED STORY, start on NEXT UP. `n` dismisses a PROPOSED STORY (`idea.dismiss`) or a DECISION NOTE (`note.dismiss`); `i` on the Desk hands a quick idea to the audit (`idea.add`).

### Per kind
- **PROPOSED STORY** (`DeskItem.idea`, DIPO-454): the story text, Why, Blocks, `Size` (only the audit's tier, `S`) and `Raised  7 min ago by reviewer (opus-5.5)` ("by <role> (<model>)") are produced by the M3 idea audit (DIPO-452, {{M3-454}}); an engine addition in step 3. `⟦ y Accept ⟧  ⟦ n Dismiss ⟧`. "Accepting files it as a Backlog draft. You refine it in a triage session." `$ dipo idea accept 3f9a01c2` (`idea.accept`; `n` is `idea.dismiss`). Accept files a Backlog draft through the planning lane, never Ready.
- **MERGE**: pipeline with `● test`, Why, Review (`approved` round 1 · 8/8 criteria), CI (`✓` 4 required checks green: required-check count and state), Change (6 files · +214 −38: file count and +/−; both from gh/git on the story PR read, an engine addition in step 3), Blocks, Tests (3 manual steps). `⟦ t Test first ⟧  ⟦ y Approve ⟧  ⟦ n Reject… ⟧  ⟦ o PR ⟧`. "Approve merges once the checks pass on the close-out head." `$ dipo approve DIPO-446`. While a test is open the row shows `● testing` and ⏎ brings the overlay back.
- **QUESTION** (`a`): the question in full, then the Composer under it (label `answer`), footer `⏎ new line   ctrl-s send   esc cancel`, "The worker gets it on resume, and the run continues." `$ dipo answer q_7f2c "…"`. Same Composer as steer, reject notes and DIPO-449.
- **PARKED** (`r`, start again): asks only for what the park reason needs; seeing the caps is the confirmation, no separate yes/no.

  | Reason | Prompt | Other keys |
  |---|---|---|
  | ambiguous-spec | The open question with the answer box (same as QUESTION) | `a` answer = `r` |
  | budget-exceeded | Top-up choice `+25%  ⟦ +50% ⟧  +100%` (←→, the same choices as `dipo resume --budget`), caps before → after from `ResumeConfirmDetails`, optional note; `ctrl-s resume   tab field   esc cancel` | none |
  | review-blocked | A note with your direction (required). The last verdict's findings are shown above it. | `y` overrule and approve, with a note |
  | verify-failing · conflict · worker-failed · by-maintainer | An optional note, prefilled with the failing check or conflicted paths you can edit | ⏎ open run |
  | scope-violation | No `r`. The preview says "Not resumable: a part touched a protected file" and names the file. | `D` discard (type the id) |

  "A fresh session starts with a handoff. The box and branch are kept." `$ dipo resume DIPO-447 --budget 50% --note "…"`.
- **NEXT UP**: `NEXT UP · run slot 2 of 3 is free` (the office's real `caps.parallelRuns`), Why, Tier (M · opus-5.5 · 2.0M tokens · 8 loops), Shares (`!` in acc before files shared with running or parked stories; overlap is what makes parallel runs expensive). `⟦ y Start it ⟧  ⟦ n Offer the next one ⟧`. "Nothing starts until you confirm. Declined stories return once their task file changes." `$ dipo next confirm DIPO-452`.
- **STARTS PAUSED**: says first that there is nothing to do: `✓ Nothing to do. Look away until it lifts.` (ok); `Lifts   by itself`. No expected times. The early lift is not bound to a key, only its cli line (`$ dipo daemon resume-starts`). A box-token pause shows `hand` instead: "Run `dipo login box` in a shell."
- **Setup issue** (PROFILE): `✗ dev profile unresolved`, second row "blocks every story in this office". Dismissing it asks for confirmation.

## Floor (S2)
File: `02-floor.txt`. Built for a second monitor.
- **RUNNING** (bold hi) with `1 of 3 slots` dim at the right (the office's real `caps.parallelRuns`; the numbers in the mocks are examples); **IN REVIEW** with its count; **UP NEXT** with `0 ready · 6 waiting`.
- A story card: focus column, state glyph (`●` ok running, `○` acc in review), dim id padded to 10, title, age right. Indented 14: the pipeline line with a right-aligned dim `loop 1 of 8` or `round 1`; `now merging · thinking 1.1s` with `budget ━━━━━━━━━━━━━━ 28%` right; `criteria 10/10 ✓ · review round 1 approved · opus-5.5`. In review: `reviewer reading · criteria 6 of 8 checked so far`.
- States are exclusive: a story is either running or in review, never both. Health shows only when stuck, looping or lost (code review).
- **UP NEXT** is a sentence the engine computes from the dependency graph and sends (engine addition in step 4): `When DIPO-447 merges → 448, 449 start in parallel, then 450 → 451, 452 → 453`. No "next decision" time. Press `3` for the full graph.

## Queue (S2b)
File: `05-queue.txt`. Replaces the "skipped…" block.
- Three groups by what you can do: **READY** (it will run), **WAITING ON A DEPENDENCY** (wait), **REFINED · not Ready yet** (you need to fix the story), each with its count right of the list.
- Row: focus column, glyph (`→` ok ready, `○` acc waiting, `✗` err refined), dim id, title, dim tier, reason column. `needs 447✗` (err) means the dependency is parked, so the wait is yours to clear; `needs 452→` (ok) means it is moving by itself; a bare `needs 449` (dim) means the dependency is itself waiting (not parked, not moving), a state the engine supplies; `next up` (ok) on the Ready row. Refined rows show the first gate failure in words (`2 unknowns`, `no test plan`); the full list is in the story view.
- `  . show done (418)` dim at the end of the list.
- Preview: `READY · tier M · offered as next up`, title, Gate (`✓ 31 rules · 1 warning R29`; `story.gate` returns the rule count, an engine addition in step 4), Needs, Unblocks, Touches, then `CHAIN` drawn as a picture (the engine computes the chain from the dependency graph and sends it, with the "everything below N waits on the park" line; engine addition in step 4) (`447✗ → 448 · 449 → 450 → 451`, `452  → 453`). When something blocks the chain the preview points to where you can fix it: "Everything below 447 waits on the park on your Desk. 1 go there." A waiting story's preview says "Waiting on DIPO-447".
- `R` run now is a capital because it spends; it skips NEXT UP and asks nothing when a slot is free.

## Retro (S2c, DIPO-453)
File: `06-retro.txt`. Every number from code.
- Period `7d  30d  all` on the rooms row (selected one hi, underlined), switched with ←→.
- `tab` switches the table between BY TIER and BY TYPE, where type is the story type (feature, bug, chore, spike…).
- Three headline numbers (bold hi, label dim): `38 merged`, `$214 spent · $5.63 per story`, `4h 10m median Ready → merged`. Rework and "Worth a look" are not part of M6 (the retro, DIPO-453, may add them later).
- **BY TIER** table (stories, cost/st, rounds, loops, Ready→merged). A value that is double the median turns err. ⏎ on any row lists the stories behind it; the focused row is on sel.
- Bars for **WHY STORIES PARKED** and **WHERE STORIES CAME FROM**, the same `━` as the pipeline and budget (one visual word for "amount"), acc, with the small rest in faint and dim.
- `P` starts a planning session that gets these numbers as text in its first message (DIPO-453 criterion #4).

## Plan (S2d, DIPO-447 to 452)
File: `07-plan.txt`.
- Header: `dipo / dipsaus-orchestrator / Plan`, `● planner live`, `$0.84 this session` (live, per session, DIPO-449). Second row: dim kind `refine · ` then the goal in hi.
- A reader, not a chat app: a centred 74-column script with speakers in a 9-column margin (`you` acc, `planner` dim); planner text is hi.
- Stories are objects in the stream: a block with a left rule (acc when confirmed, faint when proposed), `✓`/`◆`, the title in hi and dim `· S · confirmed` or `· S · proposed`, the first line of the story dim, and on the focused block `c confirm   e edit   x drop from plan` (`x` removes it from the plan; `X` elsewhere drops a story from the backlog). Confirmed ones are filed as Refined on end (DIPO-450).
- Side rail (30 columns): IN THIS PLAN, DECISIONS (what survives a fresh Claude session, DIPO-448), ON END ("1 confirmed → Refined", `Y set them Ready`, DIPO-451). A dim divider `── continued in a fresh session at 13:02 · decisions carried over (4) ──` says when a fresh session started.
- Composer across the full width at the bottom (`you ` acc, text hi): `⏎ new line   ctrl-s send   tab to stories   ctrl-e end session`, right `esc leave (keeps open)`.

## Offices (S2e)
File: `08-offices.txt`. `O` from anywhere, or launched outside a repo.
- Columns: OFFICE, NEEDS YOU (first column after the name, acc and bold: the only bold accent), RUNNING, READY, TODAY (a bar against the day's usage share; the existing ALERT wording shows in err, no extra column).
- Office state is a glyph: `●` ok live (`· open` for the current one), `!` acc starts paused, `○` dim idle (`idle 3 days`, whole row dim; last activity per office in `OfficeSummary`, an engine addition in step 2).
- `  + a  open a repository path…` dim. Footer `↑↓ move   ⏎ open   a new path`, right `esc back   q q quit`.

## Run (S3)
File: `03-run.txt`. ⏎ on a running story.
- Header path `/ Floor / DIPO-447`, `● live`. Then the title (bold hi) and the pipeline with `loop 1 of 8 · 36m`.
- Left (28 columns): PHASE, HEALTH, CRITERIA, REVIEW, VERIFY, USAGE (in, out, cache w, cache r, turns), BUDGET with its bar, MODEL, RUN.
- Right: filter tabs `all   worker   reviewer   verify   prompt`, switched with `v` (`tab` stays next pane on the Run) (current one hi, underlined) and `following ↓` dim. The sources are filters, not separate screens (today's `w`, `v`, `i` become these tabs).
- The stream is a table: time and verb dim (`10:39  read   `), target in fg, a dim argument after two spaces. Long commands show `⏎ full`. Section dividers in dim: `── review · reviewer · 10:39 ───…`.
- Thinking folds: consecutive thinking lines collapse into `··     4 thoughts · 1.0k tokens`, dim.
- The agent's own words stand out: `says   ` acc and `verdict ` ok, followed by hi text wrapped at 62 columns, hung under the target column.
- Scrolling up pauses following and shows "paused · G to follow". `z` expands the stream to full screen. `c` copies the run id.
- **Steer** (S7, second block): `s` opens the Composer at the foot of the stream (`steer DIPO-447 · arrives at its next turn`), so the context stays visible above it. Once sent, the message lands as a `you` line (`you` ok), with its delivery state from the reply (`next-turn` or `on-resume`, shown as `· delivered next turn`). A reviewer session answers "Not steerable: the reviewer is working".
- Stopping a run is in the palette only (no key) and asks for confirmation.
- Render the stream with `<Static>` for finished lines and a live tail below.

## Story reader (S4)
File: `04-story-reader.txt`. Nothing truncated.
- Header path ends in the story id. Title in bold hi; dim status line `✓ Done · merged 10:21 · 2 review rounds · 41m · $3.20 · 1 proposal raised`; section tabs `Story    Criteria 3    Reviews 2    Runs 1    Diff` (Diff needs a diff read for the story's branch, an engine addition in step 6) (current one hi, underlined), ←→ switches.
- A centred 84-column measure. Prose reads like a document; it wraps and never truncates. A story that waits on another says "Waiting on DIPO-447".
- The latest round is open (`ROUND 2` bold hi, dim head and time, `approved` ok at the right); earlier ones fold to a one-line summary (`▸ ROUND 1 · 975b20c · 10:09 · 3/3 met · 1 advisory`, ⏎ expands).
- Criteria in a 5-column margin (`✓ 1` ok). Code-ish words are tinted acc, not boxed. Quotes get a faint rule on the left.
- An advisory (`!` acc, `advisory · maintainability` acc, dim path) can become work: `f` raises it as a proposal on the Desk. The long links are gone; `o` opens the PR comment in the browser.

## Test overlay (S1d)
File: `10-test-overlay.txt`. `t` on a MERGE item; replaces room 4 "checklist".
- Overlay with an acc border, 84 columns inside: `TEST · DIPO-446 at 5cdb387 · box test-446` and `● running` ok; `open` with the underlined url (`o opens`), `shell` with the command (`c copies`); a rule; the steps (`✓ 1` ok done, `○ 3` acc open; expectation lines dim, `→ …`); the focused step on sel; a rule; `space tick   y pass   n fail…   ↑↓ step`, right `esc hide · test stays open`.
- It is tied to the item, not a room. Ticks stay local because the engine never sees them; only `y` or `n` records the result.
- `n` fail opens the Composer with the first unticked step already filled in, so the note explains where it broke. The note goes to the same builder as a fix round.
- If the head changes, the overlay says "New head 8a1e2f0, this test closed" and offers `t` to test again (the `test.ended` event).
- Pass and fail use the same keys as the item (`y`/`n`), which removes the `P` clash between park and pass.

## Command palette (S5)
File: `09-palette.txt`. `:` or `ctrl-k`, from anywhere.
- Overlay, acc border, 62 columns inside, over the shaded screen. Query line `: pa▍`. Matches underlined (acc).
- Scoped first: actions on the focused item (`ON DIPO-447`), then `SETTINGS`, then `GO TO`. Each row shows its key at the right (acc when bound, dim otherwise): `Park run  p`, `Expand stream to full screen  z`, `Open offices…  O`.
- Disabled rows say why (`Start again` faint, `not parked` dim) instead of disappearing.
- With an empty query it lists your recent commands. Rare settings live only here, like privacy (`Privacy: what dipo stores`) and slots (`Parallel slots: 3`, the office's `caps.parallelRuns`), which frees up `p`.
- Footer inside: `⏎ run   ↑↓ choose   esc close`.
- Built (DIPO-463, `palette.tsx`, `overlays.tsx`): the rows come from `keys.ts`; stopping a run is the row `Stop run` (park with a yes/no first); `Privacy: what dipo stores…` opens the privacy view, which keeps its confirmation, and `p` no longer opens it. The overlay replaces the body for now; the shaded body behind it waits for the rooms band. `P` opens the Plan view where no view binds it (park is still `P` on the desk, queue and detail; `5` also works), and the Retro room stays on `6` until the checklist leaves room 4 (step 6).

## Keys overlay (S9)
File: `13-keys-overlay.txt`. `?`, built from the same registry as the footer and palette.
- Overlay, acc border, 90 columns inside. `KEYS · Desk · on a MERGE item`, `type to search` at the right.
- Left column: THIS ITEM first (what you can do right now), then NO KEY · TYPE IT (actions without a key show their exact `cli` line). Right column: MOVE, then ANYWHERE.
- Unavailable keys stay, faint, with the reason (`r      start again  · not parked`).
- The rule is printed at the bottom: "Lowercase acts on this item. Capitals spend or destroy."
- Typing filters the overlay and ⏎ runs the match: the palette in a smaller form.
- Built (DIPO-463, `help.tsx`): ⏎ opens the palette with the typed text; `MOVE` and `ANYWHERE` list the keys that exist today (`MOVE_KEYS`, `GLOBAL_KEYS`, `NAV_KEYS` in `keys.ts`).

## States (S6, S7, S8)
Files: `12-states.txt`, `15-budget-and-failed.txt`, `16-narrow.txt`.
- **Empty Desk**: `✓ Nothing needs you.`, "The team is on it: 1 running, 1 in review.", `2 watch the floor`.
- **Daemon stopped**: header `✗ daemon stopped` (err). "The office manager isn't running." "No work is lost. Boxes pause until it's back." dim cause line, `r restart daemon    l open its log` (these two keys only on this screen). Reassure first, then the cause and one fix.
- **Budget reached** (lands on the Desk): `NEEDS YOU · BUDGET`, `! DIPO-447 paused: token budget reached`, dim usage and `Last said: “…”`, `r start again with a top-up: +25% · +50% · +100%   ⏎ inspect`. `r` opens the same top-up prompt as the PARKED preview.
- **Run failed**: `NEEDS YOU · FAILED`, `✗ DIPO-450 failed in verify, 3 of 3 attempts`, the pipeline showing where it failed (`setup ━━ ✗ build · verify ┄┄ review ┄┄ test ┄┄ merge`), the dim failing check, `r start again   s start again with a hint   ⏎ open run`. `r` is the same action as resume; the hint reuses steer.
- **Offline**: header `✗ offline since 13:40 · view frozen` (err). The body is in shade so stale data can't be mistaken for live data; reading still works; action keys disappear from the footer instead of failing when pressed (`↑↓ move   ⏎ read   q q quit   actions off while offline`).
- **Recovering because of the database** (DIPO-111/120): header `◌ daemon recovering` (acc), a full body: `! Database unavailable`, reason, backup, "Stories and code are safe: they live in git." "Only run history is at stake.", `l open daemon log   c copy the restore command`, `$ dipo daemon logs`. A plain reconcile shows only the header chip, with no body.
- **Pending and retry**: an action counts as done only once the stream passes its reply cursor (read-your-writes). The row shows `◌` and `accepting…` while pending, then the result in place: `✓ accepted · draft-31 in backlog PR #612`, or `✗ accept failed: lane.waiting · no remote` with `push access to origin failed · ^R retry`. `^R` resends with the same request id. The row stays where it is until resolved, so focus never jumps.
- **Discard (`D`)**: the only red-bordered prompt. It lists exactly what `story.losses` says will be lost, needs the note the command requires, and asks for the id typed out (ADR 0009). The ⏎ hint stays dim until the id matches.
- **Drop (`X`)**: acc border, "Archives the story and releases its claim.", `[ ] also delete its branch (space)` and "keeps 1 commit if left unticked". Ticking the box turns the border red and asks for the id, like discard (`irreversibleWhen: deleteBranch`).
- **Composer** is one multi-line input for answer, steer, reject note, resume note, fail note and plan: acc border, dim label on the first line, text hi, `▍` cursor in acc; `⏎ new line   ctrl-s send   esc cancel` under it.

## Keymap
`keymap.json` is the registry: `{id, key, label, when, priority}` for every entry, the global keys included; footer, palette, `?` overlay and mouse all read it, so keys stay consistent by construction. Every `DeskAction` without a key still shows its `cli` line. The footer's `fitHints` priority dropping stays; the registry gives each verb its priority.

Four layers. Layer 0 is enough to use dipo; each layer above it is optional speed. Lowercase letters act on the focused item and never navigate; capitals spend or destroy.
- **L0 · everyone**: `↑ ↓` move focus, `⏎` open / drill in, `esc` back / close, `tab` next pane, `1–4` Desk, Floor, Queue, Retro, `?` keys for this screen, `q q` quit (twice within 2 s; the daemon keeps working).
- **L1 · verbs on the focused item**: `y` yes (approve, accept, confirm next up, pass a test, overrule), `n` no (reject, dismiss, decline, or fail; asks for a note), `a` answer a question, `r` start again (resume a park, retry a failed run), `t` start a test (opens the checklist), `s` steer the worker, `p` park, `c` copy (the id, the test's shell line, the restore command), `f` raise an advisory as a proposal, `z` expand the stream, `R X D` run · drop · discard. Also `o` open the PR or comment in the browser and `^R` retry a failed action.
- **L2 · vim motions**: `j k` move, `h l` back / open, `g G` top / bottom (G follows the stream), `/` filter list, `n N` next / previous match only while a search is open.
- **L3 · everything else**: `:` command palette, `ctrl-k` the same for non-vim hands, `O` switch office (capital O, from anywhere), `P` open or continue the planning session.
- **Scope**: a key bound to a view wins over a global (`*`) binding in that view. On Plan `c` is confirm, not copy id; on the Run `v` switches the stream filter and `tab` stays next pane.
- Screen-only keys: Offices `a` new path; daemon stopped `r` restart and `l` log; recovering `l` log.

Confirm only discard, drop, stopping a run (palette only, no key) and dismissing a setup issue. Everything else is instant. There is no undo.

## Colour
See `roles.json`. Nine roles (bg, fg, hi, dim, faint, acc, ok, err, sel) and a tenth, shade, for overlay backdrops and the frozen offline body. Each has an ANSI slot, so dipo picks up the user's terminal theme in light and dark, and per-theme values exactly as the HTML previews paint them. Truecolor is an opt-in "Classical" theme: ink, paper and one gold (light uses the deep gold accent-700, `#7d5411`, so key hints stay readable at body size). hi is a brighter colour, not bold; bold appears only where a screen marks `**`. dim and faint are distinct, as in the previews. In 16 colours yellow becomes a dark amber on light, bright black is the dim role, and nothing is painted on the background except the focus row. Under NO_COLOR sel equals bg and only `▌` marks the focused row. Detect the theme with OSC 11, then `COLORFGBG`, then dark. In code: `Colored` changes `color?: string` to `role?: Role`.

## Glyphs
Box Drawing, Geometric Shapes and two Dingbats only, no Nerd Font glyphs. Colour is never the only signal: every state has a glyph too, so `NO_COLOR=1` still reads.

| Glyph | Meaning | `--ascii` |
|---|---|---|
| `●` | running, live | `*` |
| `○` | waiting on someone | `o` |
| `✓` | met / passed | `+` |
| `✗` | failed, blocked | `x` |
| `!` | needs judgement | `!` |
| `◆` | proposal | `#` |
| `▌` | focus bar | `>` |
| `━` | pipeline done, bars | `=` |
| `┄` | pipeline to come | `.` |
| `│` `─` | pane borders only | `\|` (─: not given) |
| `··` | folded thinking | not given |

`glyphs(ascii)` already exists for `· – …`; extend it. The mocks also use `?`, `→`, `◌`, `▍`, `▸`, `⟦ ⟧`, `┌┐└┘` and `[ ]`; neither design gives their ASCII twins.

## Building it in Ink
- One `<Frame>` component for header, rooms, body, ticker and keys. Screens provide only the body and a `keys` array; the same array feeds the footer, the `?` overlay and the palette.
- One action registry `{id, key, label, when(item), run}`; footer, palette and mouse read from it.
- `<Composer>` (step 1) is the multi-line input for every prompt (DIPO-449 needs it).
- The run stream uses `<Static>` for finished lines and a live tail.
- Layout from `useStdout().columns` and rows: ≥ 100 columns split panes, 60 to 99 one pane, below 60 columns or 16 rows the widen message.
- Theme: OSC 11, then `COLORFGBG`, then dark; respect `NO_COLOR`.
- Mouse: SGR mode 1006.
- The TUI renders what the engine computes; it never derives health, phase, desk order or skip reasons. The ten engine and contract additions, each with its step, are in `migration.md`.
- Evidence labels stay hidden (ADR 0009).

## Maintainer decisions (2026-11-06)
1. Desk order: setup first, as mock 1; `KNOWN_DESK_KINDS` changes in the engine (step 3); the TUI never re-sorts.
2. Desk headers as mock 1: `NEEDS YOU` heading, `SETUP`, `PROPOSALS · from your AI team`; mock 2 changed to match.
3. Offices is `O` everywhere (IA diagram and palette row fixed); `o` stays "open the PR" on MERGE.
4. Quit is `q q` everywhere.
5. Confirm only discard, drop, stopping a run and dismissing a setup issue.
6. No undo anywhere. Rule: lowercase acts on this item; capitals spend or destroy.
7. Lists say `needs 447✗` / `needs 452→`; previews and the reader say "Waiting on DIPO-447".
8. Budget: `r` with +25% / +50% / +100% (as `dipo resume --budget`); mock 18 changed to match, no `p park`, "Last said".
9. Run slots come from `caps.parallelRuns`; the mocks use 3 ("1 of 3 slots", "Parallel slots: 3", "run slot 2 of 3 is free").
10. Five phases everywhere, the palette backdrop included.
11. Roles: per-theme values as the previews; hi a brighter colour, bold only where marked; dim and faint distinct; sel as the previews; shade is a tenth role with an ANSI slot.
12. `+2 elsewhere · O` on the header line right after the office name (shown in `14-desk-proposals.txt`).
13. `● plan open` at the right of the Desk header while a planning session is open (shown in `01-desk.txt`).
14. Below 16 rows: the same widen message as below 60 columns.
15. Test overlay: `y` passes, `c` copies the shell line.
16. `n` is no; `n`/`N` are next/previous match only while a search is open; Offices new path is `a`.
17. `r` resume and retry are one action (start again); `r` restart daemon only on the daemon-stopped screen.
18. `y` stays yes, approve, overrule; copy id and copy the restore command are `c`.
19. `l` stays open; the daemon log is `l` only on the daemon screens.
20. `f` raises as proposal; expand stream is `z`.
21. Keep `x` (remove from the plan) and `X` (drop a story, confirmed).
22. No `+` key.
23. Undo dropped.
24. Expected `~HH:MM` times dropped everywhere.
25. The Since band stays, as an engine addition ("since you last looked" in the office read).
26. Retro rework and "Worth a look" dropped from M6.
27. No `×2` grouping.
28. Proposal size shows only the audit's tier ("Size S").
29. Spend today stays (engine addition).
30. `consequence` on `DeskAction` stays (engine addition).
