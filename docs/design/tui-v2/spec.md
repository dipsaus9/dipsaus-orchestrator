# dipo TUI v2: spec

## Job
Make the maintainer's decisions obvious, and keep everything else quiet but reachable.

## Principles
1. **Needs-you first.** The desk count is in every header, and dipo opens on the Desk when it's above 0.
2. **One verb, one key.** A key means the same thing everywhere. The footer shows only the focused item's verbs.
3. **Quiet by default.** No scheduler output in the body. Events go to a one-line ticker. Reasons live where you'd look for them (the Queue reason column).
4. **Show the pipeline.** `setup ━ build ━ review ━ test ━ merge`, drawn the same way everywhere. Verify and CI are ✓/✗ marks inside build and merge.
5. **Never truncate a decision.**

## Frame (every screen)
```
header   dipo / <office>                     ● daemon live   $spend today   HH:MM
rooms    1 Desk N   2 Floor N   3 Queue ready·waiting   4 Retro        (+N elsewhere · O)
──────────────────────────────────────────────────────────────────────────────
body     list (46-62ch) │ preview          (≥100 cols; below: single pane, ⏎ opens preview)
ticker   last 3 events, dim, one line
──────────────────────────────────────────────────────────────────────────────
keys     verbs of focused item (left)                         : commands  ? keys (right)
```
- Below 100 columns: single pane, and the ticker and "since" line drop. Below 60 columns or 16 rows: the existing NarrowBody ("widen for detail").
- Mouse (SGR 1006): click focuses, double-click is ⏎, the wheel scrolls the pane under the cursor, and clicking a room or a key hint triggers it.

## Information architecture
- **Offices** (`O`), then an **Office** with four rooms, then **Story** (⏎), then **Run** (⏎ on a running story).
- Rooms: **1 Desk** (office.desk), **2 Floor** (running + in review + up next), **3 Queue** (ready · waiting · refined), **4 Retro** (DIPO-453).
- **Plan** (`P`, DIPO-449) is a full-screen view over the frame. It stays open on esc, and the header shows `● plan open`.
- Overlays: palette (`:`/ctrl-k), keys (`?`), test (`t` on MERGE), action prompts (Composer).
- Launch: inside a repo, open that office, on the Desk if it's above 0, else the Floor. Outside a repo, open Offices. The first quit says the daemon keeps working.

## Vocabulary
| Today | v2 |
|---|---|
| [1] overview | Floor |
| Your desk | Desk (room 1) |
| [4] checklist | test overlay (t on a MERGE item) |
| PROFILE | Setup issue |
| skipped …: dependency not Done | Queue reason column: `needs 447✗` (parked) / `needs 452→` (moving) |
| run next Ready story: done | ticker event |
| since you left | "Since 09:41 · 1 merged · …", dismissed with any key |

## Desk
- Groups follow `KNOWN_DESK_KINDS` order. Within a group, the engine's order (most blocking, then oldest). Never re-sort.
- Kind glyphs: `!` starts paused / setup, `?` question, `○` waiting gate (merge), `✗` parked, `◆` proposal, `→` next up.
- Row: glyph, title, age. Second dim row: reason, plus `blocks N`.
- Preview, from DeskItem: kind · why, title, pipeline (if a story), detail, blocks, since, hand. Then buttons for bound actions, a consequence line, and the `cli` line (dim, starting with `$`).
- Proposals with the same title but different paths group as one row with "×2". The preview lists both path sets.
- After an action, focus moves to the next item. The ticker shows "Accepted · u undo" for 10 s.

### Per kind
- **QUESTION**: `a` opens the Composer under the question. `ctrl-s` sends. The answer is delivered on resume.
- **MERGE**: `t` test first, `y` approve, `n` reject (note required), `o` PR. Shows review verdict, CI, change size, blocks and the number of manual steps.
- **PARKED**: `r` resume. The prompt depends on the reason:
  - ambiguous-spec: answer box (same as QUESTION)
  - budget-exceeded: top-up +25/+50/+100%, caps before → after (ResumeConfirmDetails), optional note. Seeing the caps is the confirmation.
  - review-blocked: required note, with the last findings above it. `y` overrules and approves, with a note.
  - verify-failing, conflict, worker-failed, by-maintainer: optional note, prefilled with the failing check or paths.
  - scope-violation: no `r`. Says "Not resumable" and names the file. `D` discards.
- **NEXT UP**: `y` start, `n` offer the next one. Shows why, tier and caps, and the files shared with running or parked stories (marked `!`).
- **STARTS PAUSED**: says "Nothing to do" when it lifts by itself. The early lift is cli only. A box-token pause shows `hand`.
- **PROPOSAL**: `y` accept (files a Backlog draft via the planning lane, not Ready), `n` dismiss.

## Floor
RUNNING (n of parallelRuns slots), IN REVIEW, UP NEXT. Each story has a pipeline line, a `now:` line, budget bar, criteria and review round. Health shows only when stuck, looping or lost. RUNNING and IN REVIEW are exclusive. Up next is a sentence describing the chain, plus "Next decision for you: ~HH:MM" (prefixed `~` because it's estimated).

## Queue
Groups: READY · WAITING ON A DEPENDENCY · REFINED (not Ready yet). Reason column. Preview: gate result and warnings, needs, unblocks, touches, and the chain picture. `R` run now, `p` park, `X` drop, `.` show done.

## Run
Left: phase, health, criteria, review, verify, usage, budget bar, model, run id. Right: stream as a table (time, verb, target). Consecutive thinking folds into "·· N thoughts · Xk tokens". `says` and `verdict` lines are bright. Filters as tabs: all, worker, reviewer, verify, prompt. Scrolling up pauses following ("paused · G to follow"). `s` opens the Composer at the foot. A sent message appears as a `you` line with its delivery state.

## Story reader
Tabs: Story, Criteria, Reviews, Runs, Diff. Centred 84-column measure, wrapping. The latest review round is open and earlier rounds fold. Code-ish words are tinted and quotes get a left rule. `f` raises an advisory as a proposal. `o` opens on GitHub.

## Test overlay
`t` on MERGE. Header: story at head, box, url (`o` opens), shell (`y` copies). Steps with expectations. `space` ticks locally, `y` pass, `n` fail (note prefilled with the first unticked step). esc hides it and the test stays open. On test.ended it shows the reason and offers `t` again.

## Retro (DIPO-453)
Period 7d / 30d / all. Headline: merged, spent and per story, median Ready→merged, rework %. By tier: stories, cost per story, rounds, loops, Ready→merged (a cell more than 2× the median is red). Bars: park reasons and origins. "Worth a look": rule-based advice, no model. `⏎` shows the stories behind a row. `P` discusses it in a plan.

## Plan (DIPO-449..452)
Header: kind · goal, live session spend. Body: centred 74-column script, with speaker in the margin (you / planner). Proposed stories are blocks: `c` confirm, `e` edit, `x` drop. Side rail: stories in this plan, decisions (they survive a fresh session), and the on-end preview ("N confirmed → Refined", `Y` sets them Ready). A divider marks "continued in a fresh session". Composer at the bottom: ⏎ new line, ctrl-s send, ctrl-e end, esc leave (stays open).

## Offices
Columns: OFFICE, NEEDS YOU (bold accent), RUNNING, READY, TODAY (bar of day usage share, red with ALERT). State glyph: ● live, ! starts paused, ○ idle. `n` opens a repository path.

## Interactions and states
- **Composer** is one multi-line input for answer, steer, reject note, resume note, fail note and plan.
- **Pending**: the row shows `◌ <verb>ing…` until the stream passes the reply cursor, then `✓` result (with `u` undo where possible) or `✗ code: message` with `^R` retry (same request id). Focus doesn't move while pending.
- **Discard (D)**: red border, the story.losses commits, required note, the story id typed to confirm.
- **Drop (X)**: amber border, `[ ] also delete its branch`. Ticking it turns the border red and requires the typed id.
- **Offline**: header `✗ offline since HH:MM · view frozen`, body in the shade role, reading works, action keys are removed from the footer.
- **Recovering, database unavailable**: full body with reason, newest backup, "Stories and code are safe: they live in git", `l` log. A plain recovering shows a header chip only.
- **Daemon stopped**: "No work is lost", last seen and cause, `r` restart, `l` log.
- **Empty desk**: "✓ Nothing needs you", what the team is doing, and the next expected decision.
- **Confirm only the irreversible.** Everything else is instant, with undo.

## Color roles
See `roles.json`. Each role maps to an ANSI slot, so dipo follows the terminal theme. Truecolor "Classical" is opt-in. Detect light or dark via OSC 11, then COLORFGBG, then default to dark.

## Glyphs (unicode / ascii)
● * running · ○ o waiting · ✓ + done · ✗ x failed · ◆ # proposal · ! ! judgement · ? ? question · → > next · ▌ > focus · ━ = done phase · ┄ . future phase · │ | rule · ·· .. folded · ◌ ~ pending. No Nerd Font glyphs.
