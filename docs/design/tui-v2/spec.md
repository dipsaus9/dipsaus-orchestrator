# dipo TUI v2: spec

The screens must match `docs/design/tui-v2/designs/dipo-ux-spec.html` exactly. The text mocks in `screens/` are the same screens in text. Where the ux-spec and `designs/dipo-code-review.html` disagree, the ux-spec wins; where the ux-spec says nothing, the code review stands. Places where the ux-spec contradicts itself or needs a fact the engine does not compute are listed at the end under "Open questions for the maintainer"; until they are answered, build what the mock shows.

## Job
Make the maintainer's decisions obvious, and keep everything else quiet but reachable.

## Reading the screen files
- Each mock starts with a caption line `=== <title> · ux-spec mock <n> · <cols> cols × <rows> rows ===`. The next `<rows>` lines are the screen, cell for cell: one character is one terminal cell, spaces included, blank rows included. A line `--- notes ---` starts notes that are not part of the screen.
- `[role]text[/]` paints text in a role from `roles.json`. Roles nest; `[/]` closes the innermost one.
- `**text**` is bold and `__text__` is underlined (always in acc). Both sit inside the role.
- `[sel]…[/]` is the focused row's background; it covers the cells it wraps, padding included.
- An unmarked `│` or full-width `─` is a pane rule in faint. A box (`┌─┐ │ └─┘`) carries its border role on every border cell.
- `⟦ key Label ⟧` is a clickable button: `[acc]⟦[/]…[acc]⟧[/]` is the primary button (acc border), `[faint]⟦[/]…[faint]⟧[/]` the others.
- The HTML's sub-line gaps (0.3 to 0.6 of a line between some rows) are not rows; the text drops them. A 1px border is one cell. Fixed-height mocks are padded to their rows; the list and preview panes stretch to the body height, so their `│` runs down to the ticker.
- Overlays are drawn into the screen behind them: centred, top edge on row 2, the rows behind in shade.
- Widths: full screens are 112 columns (S6 narrow: 80). The S1c previews are the Desk's right pane, 63 columns. The S10 theme cards are drawn at 80. The S6 to S8 state cards are drawn at 112. The HTML draws those cards in fluid columns, so their width there depends on the browser window.

| File | ux-spec |
|---|---|
| `01-desk.txt` | S1b, mock 2 |
| `02-floor.txt` | S2, mock 8 |
| `03-run.txt` | S3, mock 13; S7 steer, mock 21 |
| `04-story-reader.txt` | S4, mock 14 |
| `05-queue.txt` | S2b, mock 9 |
| `06-retro.txt` | S2c, mock 10 |
| `07-plan.txt` | S2d, mock 11 |
| `08-offices.txt` | S2e, mock 12 |
| `09-palette.txt` | S5, mock 15 |
| `10-test-overlay.txt` | S1d, mock 7 |
| `11-desk-previews.txt` | S1c, mocks 3 to 6 |
| `12-states.txt` | S6 mocks 16, 17; S8 mocks 25, 26; S7 mocks 22 to 24 |
| `13-keys-overlay.txt` | S9, mock 27 |
| `14-desk-proposals.txt` | S1, mock 1 (Since band, SETUP, PROPOSALS, PROPOSAL preview) |
| `15-budget-and-failed.txt` | S6, mocks 18, 19 |
| `16-narrow.txt` | S6 at 80 × 24, mock 20 |
| `17-themes.txt` | S10, mocks 28 to 31 |

## Principles
1. **Needs-you first.** The number that matters is how many decisions wait for you. It sits in the header of every screen, and dipo opens on the Desk whenever it's above zero.
2. **One verb, one key.** A key means the same thing on every screen. The footer only shows the verbs for the item in focus.
3. **Quiet by default.** Scheduler chatter shrinks to a one-line ticker. Totals live in Retro. A reason lives where you'd look for it: the Queue explains why a story waits.
4. **Show the pipeline.** Every story sits somewhere on `setup ━━ build ━━ review ━━ test ━━ merge`, the engine's `KNOWN_PHASES`. Verify and CI are ✓/✗ marks inside a phase, not phases. Finished phases are ok, the current one is `● name` in acc, future ones are faint and dotted (`┄┄`). The same line appears on the Floor, in the Queue, the Story, the Run and the Desk preview.
5. **Never truncate a decision.** Lists can use `…`. Anything you judge (story text, findings, questions) wraps in full in a preview or reader pane.

## Information architecture
Three levels and four rooms. Drill down with ⏎ and climb back with esc. Overlays sit above every level.
- **Offices** (one per product repo) → **Office** with four rooms → **Story** (⏎: story · criteria · reviews · runs) → **Run** (⏎ on a running story: live stream, steer, park).
- Rooms: **1 Desk** (needs you, `office.desk`), **2 Floor** (running, in review), **3 Queue** (ready, waiting), **4 Retro** (done, cost, rework; DIPO-453).
- **Plan** (`P` from anywhere, DIPO-447 to 452) is a document view in the Frame. Esc leaves it open, the Desk header shows `● plan open`, and reopening the TUI goes straight back to it.
- Overlays: `:` or `ctrl-k` the command palette (everything is reachable there), `?` every key for this screen, `/` filter the list in focus, `t` the test overlay, and the Composer prompts.
- **Launch rule.** Inside a repo, `dipo` opens that office: on the Desk if anything needs you, otherwise on the Floor. Outside a repo it opens Offices. Quitting the TUI never stops the daemon, and the first quit of a session says so once.

## Vocabulary
Keep the office metaphor; every word is a place or a person.

| Today | Becomes | Why |
|---|---|---|
| [1] overview | Floor | The place where work happens. |
| Your desk | Desk | Only things that wait for you. Room 1. |
| PROFILE | Setup issue | Something in config blocks the office. The Desk group header reads `SETUP`. |
| skipped …: dependency not Done | Waiting on DIPO-447 | Shown in the Queue next to the story, not as a log line. The Queue mock draws it as the group `WAITING ON A DEPENDENCY` and the reason `needs 447✗`. |
| run next Ready story: done | ticker event | One dim line above the footer, then gone. |
| since you left: … | Since 09:41 | A summary band you dismiss with any key. |
| [4] checklist | open question | The test overlay, opened by `t` (S1d). |

Engine words the screens use as they are (code review): lifecycle Refined → Ready → In Progress → In Review → Done, any of them → Parked → back; Parked is the only waiting state; discard returns a story to Refined and drop archives it. Health: busy · quiet · stuck · looping · lost. Park reasons: ambiguous-spec · budget-exceeded · verify-failing · conflict · review-blocked · scope-violation · worker-failed · by-maintainer.

## The frame
Every screen uses the same five bands.
```
header   dipo / <office>                               ● daemon live    $19.14 today    10:42
rooms    1 Desk 3    2 Floor 2    3 Queue 0·6    4 Retro
────────────────────────────────────────────────────────────────────────────────────────────
body     list (46 cols) │  preview                 (≥ 100 cols; the Since band sits above it)
ticker   10:41 merged DIPO-444  ·  10:40 DIPO-447 → merge  ·  …   (dim, one line)
────────────────────────────────────────────────────────────────────────────────────────────
keys     verbs for the focused item (left)                               : commands   ? keys
```
- **Header**: `dipo` in acc and bold, ` / ` dim, then the office (fg). Right: `●` ok, ` daemon live` fg, then dim `    $19.14 today    10:42`. Deeper levels extend the path in dim (`dipo / dipsaus-orchestrator / Floor / ` then `DIPO-447` in fg) and show `● live` and the time. Plan shows `● planner live` and `$0.84 this session`. Offices shows `$27.10 today, all offices`.
- **Rooms**: gap of 4 spaces (3 at 80 columns). The current room is hi with an acc underline; the others are dim. Desk's count is acc. Queue shows `ready·waiting` (`0·6`); at 80 columns it shows `3 Queue` without counts. Retro has no count; on Retro the period switch `7d  30d  all` sits at the right end of the rooms row.
- **Since band** (Desk, 100 columns or wider): dim `Since 09:41 · ` then `1 merged` in fg, dim ` · 2 new proposals · $4.10 spent`, and `any key to dismiss` at the right, between two rules.
- **Body**: list on the left (46 columns on the Desk, 62 on the Queue, 57 on Retro, 28 on the Run), `│` in faint, two spaces, then the preview.
- **Ticker**: the latest events, dim, `  ·  ` between them. After acting, a dim `Accepted · u undo` stays in it for 10 s.
- **Keys**: verbs for the focused item on the left (key in acc, label in fg, 3 spaces apart); global keys on the right, labels dim (`: commands   ? keys`, or `esc back   ? keys`, `/ filter   ? keys`, `esc back   q quit`).
- Mouse (SGR 1006): click focuses a row, double-click is ⏎, the wheel scrolls the pane under the cursor, and clicking a room or a key hint triggers it.
- The office header shows other offices that need you as `+2 elsewhere · O`, from `office.summary`. No mock shows where (Open questions).

### Widths
- 100 columns or more: split panes.
- 60 to 99 columns: single pane, ⏎ opens the preview full screen. Each list row keeps its most important secondary line. The ticker and the Since line drop out. The header shortens the office name (`dipsaus-orch…`) before it drops the daemon dot. See `16-narrow.txt`.
- Below 60 columns: dipo shows "Widen the terminal to at least 60 columns" instead of a broken layout.
- Below 16 rows: the code review's rule stands (one list with "widen for detail"); the ux-spec says nothing about rows.
- Read the width from `useStdout().columns`.

## Desk (S1, S1b, S1c)
Files: `14-desk-proposals.txt`, `01-desk.txt`, `11-desk-previews.txt`.
- **Groups.** One dim header per kind, rows under it. The engine sets the order: groups follow `KNOWN_DESK_KINDS` (STARTS PAUSED, QUESTION, SCOPE, MERGE, PARKED, PR HEAD CHANGED, DONE ELSEWHERE, LEFTOVERS, BACKLOG PR, PLANNING LANE, NOTICE, PROPOSAL, NEXT UP, PARKED BY YOU, PROFILE, LOADING). Within a group the engine puts the most-blocking item first, then the oldest. The TUI never re-sorts. Mock 1 also shows a bold `NEEDS YOU` heading with the count in acc, a `SETUP` group first and a `PROPOSALS · from your AI team` header (Open questions).
- **Row**: two-cell focus column (`▌` in acc when focused), the kind glyph in its role plus a space, the title (hi when focused), the age right-aligned in dim with two trailing spaces. Second row, dim, indented 4: the reason, plus `blocks N` when it holds others up. The focused item's two rows are on sel.
- **Kind glyphs**: `!` paused (acc), `?` question (acc), `○` waiting gate (acc), `✗` parked or setup issue (err), `◆` proposal (acc), `→` next up (ok). They stay readable under NO_COLOR.
- **Duplicates merge.** Proposals for the same story with near-identical titles collapse into one row marked `×2 merged` (fg) in the second row; at 80 columns `×2` (dim) after the title. The code review keeps this as a display grouping and the preview shows both path sets.
- **Preview** (from `DeskItem`: `detail`, `blocks`, `since`, `hand`, `actions`): dim `KIND · why` line, the bold hi title, the pipeline line for a story, the full text (wrapped at 60 columns), then dim labels padded to 8 (`Why`, `Blocks`, `Size`, `Raised`, `Review`, `CI`, `Change`, `Tests`, `Tier`, `Shares`, `Reason`, `Lifts`, `Running`, `Parked`). Then the buttons for the bound actions, 2 spaces apart, the first one primary. Then the dim consequence line (what the action will do) and the dim `$ dipo …` cli line, so the TUI teaches the CLI.
- **Verbs live once**: as buttons in the preview and keys in the footer, never on each row. Buttons are clickable.
- **After acting**, focus moves to the next item.
- `y` means what the item asks: approve on MERGE, accept on PROPOSAL, start on NEXT UP.

### Per kind
- **PROPOSAL**: `⟦ y Accept ⟧  ⟦ n Dismiss ⟧`. "Accepting files it as a Backlog draft. You refine it in a planning session." `$ dipo proposal accept 3f9a01c2`. Accept files a Backlog draft through the planning lane, never Ready.
- **MERGE**: pipeline with `● test`, Why, Review (`approved` round 1 · 8/8 criteria), CI (`✓` 4 required checks green), Change (6 files · +214 −38), Blocks, Tests (3 manual steps). `⟦ t Test first ⟧  ⟦ y Approve ⟧  ⟦ n Reject… ⟧  ⟦ o PR ⟧`. "Approve merges once the checks pass on the close-out head." `$ dipo approve DIPO-446`. While a test is open the row shows `● testing` and ⏎ brings the overlay back.
- **QUESTION** (`a`): the question in full, then the Composer under it (label `answer`), footer `⏎ new line   ctrl-s send   esc cancel`, "The worker gets it on resume, and the run continues." `$ dipo answer q_7f2c "…"`. Same Composer as steer, reject notes and DIPO-449.
- **PARKED** (`r`): asks only for what the park reason needs; seeing the caps is the confirmation, no separate yes/no.

  | Reason | Prompt | Other keys |
  |---|---|---|
  | ambiguous-spec | The open question with the answer box (same as QUESTION) | `a` answer = `r` |
  | budget-exceeded | Top-up choice `+25%  ⟦ +50% ⟧  +100%` (←→), caps before → after from `ResumeConfirmDetails`, optional note; `ctrl-s resume   tab field   esc cancel` | none |
  | review-blocked | A note with your direction (required). The last verdict's findings are shown above it. | `y` overrule and approve, with a note |
  | verify-failing · conflict · worker-failed · by-maintainer | An optional note, prefilled with the failing check or conflicted paths you can edit | ⏎ open run |
  | scope-violation | No `r`. The preview says "Not resumable: a part touched a protected file" and names the file. | `D` discard (type the id) |

  "A fresh session starts with a handoff. The box and branch are kept." `$ dipo resume DIPO-447 --budget 50% --note "…"`.
- **NEXT UP**: `NEXT UP · run slot 2 of 3 is free`, Why, Tier (M · opus-5.5 · 2.0M tokens · 8 loops), Shares (`!` in acc before files shared with running or parked stories; overlap is what makes parallel runs expensive). `⟦ y Start it ⟧  ⟦ n Offer the next one ⟧`. "Nothing starts until you confirm. Declined stories return once their task file changes." `$ dipo next confirm DIPO-452`.
- **STARTS PAUSED**: says first that there is nothing to do: `✓ Nothing to do. Look away until ~14:00.` (ok). The early lift is not bound to a key, only its cli line (`$ dipo daemon resume-starts`). A box-token pause shows `hand` instead: "Run `dipo login box` in a shell."
- **Setup issue** (PROFILE): `✗ dev profile unresolved`, second row "blocks every story in this office".

## Floor (S2)
File: `02-floor.txt`. Built for a second monitor.
- **RUNNING** (bold hi) with `1 of 2 slots` dim at the right; **IN REVIEW** with its count; **UP NEXT** with `0 ready · 6 waiting`.
- A story card: focus column, state glyph (`●` ok running, `○` acc in review), dim id padded to 10, title, age right. Indented 14: the pipeline line with a right-aligned dim `loop 1 of 8` or `round 1`; `now merging · thinking 1.1s` with `budget ━━━━━━━━━━━━━━ 28%` right; `criteria 10/10 ✓ · review round 1 approved · opus-5.5`. In review: `reviewer reading · criteria 6 of 8 checked so far`.
- States are exclusive: a story is either running or in review, never both. Health shows only when stuck, looping or lost (code review).
- **UP NEXT** is a sentence: `When DIPO-447 merges → 448, 449 start in parallel, then 450 → 451, 452 → 453`, then dim `Next decision for you: expected ~11:20, DIPO-446 review verdict`. Press `3` for the full graph. "Next decision" is a promise: it tells you when you can look away.

## Queue (S2b)
File: `05-queue.txt`. Replaces the "skipped…" block.
- Three groups by what you can do: **READY** (it will run), **WAITING ON A DEPENDENCY** (wait), **REFINED · not Ready yet** (you need to fix the story), each with its count right of the list.
- Row: focus column, glyph (`→` ok ready, `○` acc waiting, `✗` err refined), dim id, title, dim tier, reason column. `needs 447✗` (err) means the dependency is parked, so the wait is yours to clear; `needs 452→` (ok) means it is moving by itself; `next up` (ok) on the Ready row. Refined rows show the first gate failure in words (`2 unknowns`, `no test plan`); the full list is in the story view.
- `  . show done (418)` dim at the end of the list.
- Preview: `READY · tier M · offered as next up`, title, Gate (`✓ 31 rules · 1 warning R29`), Needs, Unblocks, Touches, then `CHAIN` drawn as a picture (`447✗ → 448 · 449 → 450 → 451`, `452  → 453`). When something blocks the chain the preview points to where you can fix it: "Everything below 447 waits on the park on your Desk. 1 go there."
- `R` run now is a capital because it spends; it skips NEXT UP and asks nothing when a slot is free.

## Retro (S2c, DIPO-453)
File: `06-retro.txt`. Every number from code.
- Period `7d  30d  all` on the rooms row (selected one hi, underlined), switched with ←→.
- Four headline numbers (bold hi, label dim): `38 merged`, `$214 spent · $5.63 per story`, `4h 10m median Ready → merged`, `18% rework`.
- **BY TIER** table (stories, cost/st, rounds, loops, Ready→merged). A value that is double the median turns err. ⏎ on any row lists the stories behind it; the focused row is on sel.
- Bars for **WHY STORIES PARKED** and **WHERE STORIES CAME FROM**, the same `━` as the pipeline and budget (one visual word for "amount"), acc, with the small rest in faint and dim.
- **WORTH A LOOK**: fixed rules over the same numbers, worded as advice, no model. Then the dim definition of rework: "rework = most changed files were changed by another story merged in the 14 days before".
- `P` starts a planning session that gets these numbers as text in its first message (DIPO-453 criterion #4).

## Plan (S2d, DIPO-447 to 452)
File: `07-plan.txt`.
- Header: `dipo / dipsaus-orchestrator / Plan`, `● planner live`, `$0.84 this session` (live, per session, DIPO-449). Second row: dim kind `refine · ` then the goal in hi.
- A reader, not a chat app: a centred 74-column script with speakers in a 9-column margin (`you` acc, `planner` dim); planner text is hi.
- Stories are objects in the stream: a block with a left rule (acc when confirmed, faint when proposed), `✓`/`◆`, the title in hi and dim `· S · confirmed` or `· S · proposed`, the first line of the story dim, and on the focused block `c confirm   e edit   x drop from plan`. Confirmed ones are filed as Refined on end (DIPO-450).
- Side rail (30 columns): IN THIS PLAN, DECISIONS (what survives a fresh Claude session, DIPO-448), ON END ("1 confirmed → Refined", `Y set them Ready`, DIPO-451). A dim divider `── continued in a fresh session at 13:02 · decisions carried over (4) ──` says when a fresh session started.
- Composer across the full width at the bottom (`you ` acc, text hi): `⏎ new line   ctrl-s send   tab to stories   ctrl-e end session`, right `esc leave (keeps open)`.

## Offices (S2e)
File: `08-offices.txt`. `O` from anywhere, or launched outside a repo.
- Columns: OFFICE, NEEDS YOU (first column after the name, acc and bold: the only bold accent), RUNNING, READY, TODAY (a bar against the day's usage share; the existing ALERT wording shows in err, no extra column).
- Office state is a glyph: `●` ok live (`· open` for the current one), `!` acc starts paused, `○` dim idle (`idle 3 days`, whole row dim).
- `  + n  open a repository path…` dim. Footer `↑↓ move   ⏎ open   n new path`, right `esc back   q quit`.

## Run (S3)
File: `03-run.txt`. ⏎ on a running story.
- Header path `/ Floor / DIPO-447`, `● live`. Then the title (bold hi) and the pipeline with `loop 1 of 8 · 36m`.
- Left (28 columns): PHASE, HEALTH, CRITERIA, REVIEW, VERIFY, USAGE (in, out, cache w, cache r, turns), BUDGET with its bar, MODEL, RUN.
- Right: filter tabs `all   worker   reviewer   verify   prompt` (current one hi, underlined) and `following ↓` dim. The sources are filters, not separate screens (today's `w`, `v`, `i` become these tabs).
- The stream is a table: time and verb dim (`10:39  read   `), target in fg, a dim argument after two spaces. Long commands show `⏎ full`. Section dividers in dim: `── review · reviewer · 10:39 ───…`.
- Thinking folds: consecutive thinking lines collapse into `··     4 thoughts · 1.0k tokens`, dim.
- The agent's own words stand out: `says   ` acc and `verdict ` ok, followed by hi text wrapped at 62 columns, hung under the target column.
- Scrolling up pauses following and shows "paused · G to follow".
- **Steer** (S7, second block): `s` opens the Composer at the foot of the stream (`steer DIPO-447 · arrives at its next turn`), so the context stays visible above it. Once sent, the message lands as a `you` line (`you` ok), with its delivery state from the reply (`next-turn` or `on-resume`, shown as `· delivered next turn`). A reviewer session answers "Not steerable: the reviewer is working".
- Render the stream with `<Static>` for finished lines and a live tail below.

## Story reader (S4)
File: `04-story-reader.txt`. Nothing truncated.
- Header path ends in the story id. Title in bold hi; dim status line `✓ Done · merged 10:21 · 2 review rounds · 41m · $3.20 · 1 proposal raised`; section tabs `Story    Criteria 3    Reviews 2    Runs 1    Diff` (current one hi, underlined), ←→ switches.
- A centred 84-column measure. Prose reads like a document; it wraps and never truncates.
- The latest round is open (`ROUND 2` bold hi, dim head and time, `approved` ok at the right); earlier ones fold to a one-line summary (`▸ ROUND 1 · 975b20c · 10:09 · 3/3 met · 1 advisory`, ⏎ expands).
- Criteria in a 5-column margin (`✓ 1` ok). Code-ish words are tinted acc, not boxed. Quotes get a faint rule on the left.
- An advisory (`!` acc, `advisory · maintainability` acc, dim path) can become work: `f` raises it as a proposal on the Desk. The long links are gone; `o` opens the PR comment in the browser.

## Test overlay (S1d)
File: `10-test-overlay.txt`. `t` on a MERGE item; replaces room 4 "checklist".
- Overlay with an acc border, 84 columns inside: `TEST · DIPO-446 at 5cdb387 · box test-446` and `● running` ok; `open` with the underlined url (`o opens`), `shell` with the command (`y copies`); a rule; the steps (`✓ 1` ok done, `○ 3` acc open; expectation lines dim, `→ …`); the focused step on sel; a rule; `space tick   y pass   n fail…   ↑↓ step`, right `esc hide · test stays open`.
- It is tied to the item, not a room. Ticks stay local because the engine never sees them; only `y` or `n` records the result.
- `n` fail opens the Composer with the first unticked step already filled in, so the note explains where it broke. The note goes to the same builder as a fix round.
- If the head changes, the overlay says "New head 8a1e2f0, this test closed" and offers `t` to test again (the `test.ended` event).
- Pass and fail use the same keys as the item (`y`/`n`), which removes the `P` clash between park and pass.

## Command palette (S5)
File: `09-palette.txt`. `:` or `ctrl-k`, from anywhere.
- Overlay, acc border, 62 columns inside, over the shaded screen. Query line `: pa▍`. Matches underlined (acc).
- Scoped first: actions on the focused item (`ON DIPO-447`), then `SETTINGS`, then `GO TO`. Each row shows its key at the right (acc when bound, dim otherwise).
- Disabled rows say why (`Resume run` faint, `not parked` dim) instead of disappearing.
- With an empty query it lists your recent commands. Rare settings live only here, like privacy (`Privacy: what dipo stores`) and slots (`Parallel slots: 2`), which frees up `p`.
- Footer inside: `⏎ run   ↑↓ choose   esc close`.

## Keys overlay (S9)
File: `13-keys-overlay.txt`. `?`, built from the same registry as the footer and palette.
- Overlay, acc border, 90 columns inside. `KEYS · Desk · on a MERGE item`, `type to search` at the right.
- Left column: THIS ITEM first (what you can do right now), then NO KEY · TYPE IT (actions without a key show their exact `cli` line). Right column: MOVE, then ANYWHERE.
- Unavailable keys stay, faint, with the reason (`r      resume  · not parked`).
- The rule is printed at the bottom: "Lowercase acts on this item and can be undone. Capitals spend or destroy."
- Typing filters the overlay and ⏎ runs the match: the palette in a smaller form.

## States (S6, S7, S8)
Files: `12-states.txt`, `15-budget-and-failed.txt`, `16-narrow.txt`.
- **Empty Desk**: `✓ Nothing needs you.`, "The team is on it: 1 running, 1 in review.", dim "Next decision likely ~11:20 (DIPO-446 verdict).", `2 watch the floor`. A positive state with a reason to look away.
- **Daemon stopped**: header `✗ daemon stopped` (err). "The office manager isn't running." "No work is lost. Boxes pause until it's back." dim cause line, `r restart daemon    l open its log`. Reassure first, then the cause and one fix.
- **Budget reached** (lands on the Desk): `NEEDS YOU · BUDGET`, `! DIPO-447 paused: token budget reached`, dim usage and the last thing the worker said, `+ add 1M and continue   p park   ⏎ inspect`.
- **Run failed**: `NEEDS YOU · FAILED`, `✗ DIPO-450 failed in verify, 3 of 3 attempts`, the pipeline showing where it failed (`setup ━━ ✗ build · verify ┄┄ review ┄┄ test ┄┄ merge`), the dim failing check, `r retry   s retry with a hint   ⏎ open run`. "Retry with a hint" reuses steer.
- **Offline**: header `✗ offline since 13:40 · view frozen` (err). The body is in shade so stale data can't be mistaken for live data; reading still works; action keys disappear from the footer instead of failing when pressed (`↑↓ move   ⏎ read   q quit   actions off while offline`).
- **Recovering because of the database** (DIPO-111/120): header `◌ daemon recovering` (acc), a full body: `! Database unavailable`, reason, backup, "Stories and code are safe: they live in git." "Only run history is at stake.", `l open daemon log   y copy the restore command`, `$ dipo daemon logs`. A plain reconcile shows only the header chip, with no body.
- **Pending and retry**: an action counts as done only once the stream passes its reply cursor (read-your-writes). The row shows `◌` and `accepting…` while pending, then the result in place: `✓ accepted · draft-31 in backlog PR #612   u undo`, or `✗ accept failed: lane.waiting · no remote` with `push access to origin failed · ^R retry`. `^R` resends with the same request id. The row stays where it is until resolved, so focus never jumps.
- **Discard (`D`)**: the only red-bordered prompt. It lists exactly what `story.losses` says will be lost, needs the note the command requires, and asks for the id typed out (ADR 0009). The ⏎ hint stays dim until the id matches.
- **Drop (`X`)**: acc border, "Archives the story and releases its claim.", `[ ] also delete its branch (space)` and "keeps 1 commit if left unticked". Ticking the box turns the border red and asks for the id, like discard (`irreversibleWhen: deleteBranch`). One prompt, two levels of risk.
- **Composer** is one multi-line input for answer, steer, reject note, resume note, fail note and plan: acc border, dim label on the first line, text hi, `▍` cursor in acc; `⏎ new line   ctrl-s send   esc cancel` under it.

## Keymap
`keymap.json` is the registry: `{id, key, label, when, priority}` per action; footer, palette, `?` overlay and mouse all read it, so keys stay consistent by construction. Every `DeskAction` without a key still shows its `cli` line. The footer's `fitHints` priority dropping stays; the registry gives each verb its priority.

Four layers. Layer 0 is enough to use dipo; each layer above it is optional speed. Lowercase letters are verbs and never navigate.
- **L0 · everyone**: `↑ ↓` move focus, `⏎` open / drill in, `esc` back / close, `tab` next pane, `1–4` Desk, Floor, Queue, Retro, `?` keys for this screen, `q` quit (daemon keeps working).
- **L1 · verbs on the focused item**: `y` yes (approve, accept, confirm next up, pass a test), `n` no (reject, dismiss, decline, or fail; asks for a note), `a` answer a question, `r` resume a park, `t` start a test (opens the checklist), `s` steer the worker, `p` park, `R X D` run · drop · discard (capitals spend or destroy). Also `o` open the PR or comment in the browser, `^R` retry a failed action, `u` undo.
- **L2 · vim motions**: `j k` move, `h l` back / open, `g G` top / bottom (G follows the stream), `/` filter list, `n N` next / previous match, `y` copy id.
- **L3 · everything else**: `:` command palette, `ctrl-k` the same for non-vim hands, `O` switch office (capital O, from anywhere), `P` open or continue the planning session.

Confirm only for actions you can't undo: stopping a run and dismissing a setup issue. Everything else is instant with undo.

## Colour
See `roles.json`. Nine roles (bg, fg, hi, dim, faint, acc, ok, err, sel), each mapped to an ANSI slot, so dipo picks up the user's terminal theme in light and dark; the mocks also use shade. Truecolor is an opt-in "Classical" theme: ink, paper and one gold (light uses the deep gold accent-700, `#7d5411`, so key hints stay readable at body size). In 16 colours yellow becomes a dark amber on light, bright black is the dim role, and nothing is painted on the background except the focus row. Under NO_COLOR sel equals bg and only `▌` marks the focused row. Detect the theme with OSC 11, then `COLORFGBG`, then dark. In code: `Colored` changes `color?: string` to `role?: Role`.

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

`glyphs(ascii)` already exists for `· – …`; extend it. The mocks also use `?`, `→`, `◌`, `▍`, `▸`, `×`, `⟦ ⟧`, `┌┐└┘` and `[ ]`; neither design gives their ASCII twins (Open questions).

## Building it in Ink
- One `<Frame>` component for header, rooms, body, ticker and keys. Screens provide only the body and a `keys` array; the same array feeds the footer, the `?` overlay and the palette.
- One action registry `{id, key, label, when(item), run}`; footer, palette and mouse read from it.
- `<Composer>` (step 1) is the multi-line input for every prompt (DIPO-449 needs it).
- The run stream uses `<Static>` for finished lines and a live tail.
- Layout from `useStdout().columns`: ≥ 100 split panes, 60 to 99 one pane, below 60 the widen message.
- Theme: OSC 11, then `COLORFGBG`, then dark; respect `NO_COLOR`.
- Mouse: SGR mode 1006.
- The TUI renders what the engine computes; it never derives health, phase, desk order or skip reasons. Contract additions: spend today in the office summary (for the header) and an optional `consequence` line on `DeskAction` (`migration.md`).
- Evidence labels stay hidden (ADR 0009); a dim `~` before estimated numbers (`~11:20`) is the honest mark.

## Open questions for the maintainer
Each item says what the mock shows; build that until it is answered.

**The ux-spec contradicts itself**
1. Desk order. Mock 1 shows `SETUP` first ("Grouped by kind, with setup first"), but S1b says the engine sets the order with `KNOWN_DESK_KINDS`, where PROFILE is 15th of 16 and the TUI never re-sorts.
2. Desk group headers. Mock 1 has a `NEEDS YOU 3` heading and plural headers (`SETUP`, `PROPOSALS · from your AI team`); mock 2 has no heading and the engine's kind names (`PROPOSAL`, `MERGE`, `STARTS PAUSED`).
3. Offices key. The IA diagram and the palette row (`Open offices…  o`) show `o`; the keymap L3, the keys overlay, S2e ("O from anywhere") and the header text (`+2 elsewhere · O`) show `O`. `o` is also "open the PR" on MERGE.
4. Quit. Keymap L0 says `q`; the keys overlay mock says `q q`.
5. Confirm rule. "Confirm only for actions you can't undo: stopping a run and dismissing a setup issue", but mocks 23 and 24 confirm discard and drop, no key or mock exists for stopping a run, and none for dismissing a setup issue.
6. Undo. "Lowercase acts on this item and can be undone" and "Everything else is instant with undo", but `n` reject, `p` park and `y` approve (which merges) have no undo shown.
7. Waiting words. The vocabulary says "Waiting on DIPO-447"; the Queue mock says `WAITING ON A DEPENDENCY` and `needs 447✗`.
8. Budget top-up. Mock 4 offers `+25% · +50% · +100%` via `r`; mock 18 offers `+ add 1M and continue` and `p park` on a story that is already parked. Mock 4 says "Last said:", mock 18 "Last says:".
9. Run slots. The palette says `Parallel slots: 2`, the Floor `1 of 2 slots`, the NEXT UP preview `run slot 2 of 3 is free`.
10. Phases. The shaded Floor behind the palette (mock 15) still draws `build ━━━━━━ verify ━━━━━━ review ━━━━━━ ● merge`, not the five phases.
11. Colour roles. The legend says hi is "bold fg", but the mocks bold only some hi text (marked `**`) and the ansi16 preview paints hi as a brighter colour. dim and faint share the "bright black" slot, but the previews paint them differently. sel is "inverse fallback" in the legend, but `#262626`/`#eeeeee` in the 16-colour previews and bg under NO_COLOR. shade is not one of the nine roles and has no ANSI slot.
12. Office header. "In every office header, other offices that need you show as `+2 elsewhere · O`", but no mock shows it or where it goes.
13. Plan open. "The Desk header shows `● plan open`", but no Desk mock shows it.
14. Narrow rows. The ux-spec gives only the 60-column rule; the code review also says below 16 rows. No mock shows the widen message.

**Key clashes**
15. `y` in the test overlay both passes the test and copies the shell line (`y copies`).
16. `n` is "no" (L1) and "next match" (L2), and "new path" on Offices.
17. `r` is resume (L1), retry on a failed run (mock 19) and restart daemon (mock 17).
18. `y` is also overrule-and-approve on review-blocked, copy id (L2, Run) and copy the restore command (recovering).
19. `l` is open (L2) and open the daemon log (mocks 17, 26).
20. `f` is "raise as proposal" in the reader and "Expand stream to full screen" in the palette.
21. `x` drops a story from the plan in lowercase, while `X` (capital) is drop.
22. `+` (mock 18) is in no keymap table.

**Facts the engine does not compute today**
23. Undo (`u undo`, "Accepted · u undo"): the contract has no undo.
24. "Next decision for you: expected ~11:20", "Next decision likely ~11:20", "Lifts by itself, expected ~14:00".
25. The "Since 09:41 · 1 merged · 2 new proposals · $4.10 spent" summary data.
26. Rule-based "Worth a look" advice and the rework measure.
27. Proposal grouping (`×2 merged`) for near-identical titles: the engine de-dupes only on the same title and paths, and the TUI must not derive.
28. The proposal preview's `Size  S · about 1 loop · ~180k tokens` estimate.
29. "Spend today" in the header (a contract addition, `migration.md`).
30. The `consequence` line on a `DeskAction` (a contract addition; until then a TUI map).

**Could not be reproduced exactly in text**
31. The preview's consequence line in mock 1 ("Accepting files it as a Backlog draft. You refine it in a planning session.") and the resume line in mock 4 ("A fresh session starts with a handoff. The box and branch are kept.") are single unwrapped lines in the HTML that run past their pane; the text wraps them at the pane width.
32. Sub-line gaps (0.3 to 0.6 of a line) between rows, the underline offset and the rounded corners have no terminal form and are dropped.
33. Fluid card widths (S1c, S6 to S8, S10) depend on the browser window; the text fixes them as listed under "Reading the screen files".
