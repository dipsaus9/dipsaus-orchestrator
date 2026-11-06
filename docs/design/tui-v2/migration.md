# Migration: today's TUI → v2

Each step is a story dipo can run on its own (filed as M6 stories). Dependency: DIPO-443 (one part per mode), which is done. Every step's screens must match `docs/design/tui-v2/designs/dipo-ux-spec.html` exactly; the text mocks in `screens/` are the same screens in text, and `spec.md` lists the maintainer's decisions of 2026-11-06, which win over the HTML where they differ.

| # | Step | Tier | Needs | Screens | Files |
|---|---|---|---|---|---|
| 1 | Foundations: nine colour roles (plus shade), Frame, action registry, Composer | M | none | `17-themes.txt`; the Frame bands of every screen; the widen message | colour.tsx → `role`; screen.tsx → `<Frame>`; keys.ts → registry with label/when/priority; footer.ts reads registry; + composer.tsx |
| 2 | Quiet down: clear the RunResult panel, ticker, header diet with spend today, key remap, daemon states, Offices | S | 1 | headers and footers of every screen; `08-offices.txt`; offline, recovering and daemon stopped in `12-states.txt` | app.tsx panel; views.tsx Header; keys.ts; offices view |
| 3 | Desk with preview and kind groups, setup first, Since band, consequence lines | M | 2, DIPO-452, {{M3-454}} | `14-desk-proposals.txt`, `01-desk.txt`, `11-desk-previews.txt`, `15-budget-and-failed.txt`, `16-narrow.txt`; empty Desk, pending, discard and drop in `12-states.txt` | desk.tsx split; + desk-preview.tsx; keys.ts rowKeys |
| 4 | Floor, Queue and `<Pipeline>` | M | 1, 2 | `02-floor.txt`, `05-queue.txt` | overview.tsx; queue.tsx; + pipeline.tsx; run.tsx |
| 5 | Run stream as a table | M | 4 | `03-run.txt` | output.ts folding; detail.tsx tabs; `<Static>` for finished lines |
| 6 | Story reader and test overlay | S | 3 | `04-story-reader.txt`, `10-test-overlay.txt` | story-card.tsx; checklist.tsx → overlay; detail.tsx |
| 7 | Palette, keys overlay, the Plan view and the Retro room | M | 1 (+ DIPO-449/453) | `09-palette.txt`, `13-keys-overlay.txt`, `07-plan.txt`, `06-retro.txt` | + palette.tsx; + help.tsx; settings.tsx → palette |

## What each step builds
1. `Colored` takes a role instead of a raw colour (`color?: string` → `role?: Role`): the nine roles of `roles.json` plus shade, each on its ANSI slot, the truecolor Classical theme as an opt-in, theme detection (OSC 11, `COLORFGBG`, dark), NO_COLOR (sel equals bg, only `▌` marks the row) and `--ascii` twins. A `<Frame>` owns header, rooms, body, ticker and keys, and shows "Widen the terminal to at least 60 columns" below 60 columns. The key table grows label, when() and priority, and footer, help and palette read from it. Add the `<Composer>` multi-line input. Nothing visible changes yet apart from the colours.
2. Clear the RunResult skipped block after the next key and send it to the ticker. Move privacy words out of the header; the header shows `dipo / <office>`, `+2 elsewhere · O` when other offices need you, the daemon dot and word, spend today (engine addition 3) and the time. Remap keys per `keymap.json` (`changedFromToday`). Offline, recovering and daemon stopped get the bodies and header chips of `12-states.txt`. Offices gets the NEEDS YOU first column, state glyphs, the TODAY bar and `a` for a new path. Quit is `q q`.
3. Split the list and preview at 100 columns or wider. The `NEEDS YOU` heading and kind group headers (`SETUP`, `PROPOSALS · from your AI team`) in engine order, with setup kinds first (engine addition 1). `● plan open` in the header while a planning session is open. The preview shows detail, blocks, since, hand, buttons for bound actions (first one primary) and cli lines for unbound ones. NEXT UP gets y/n. QUESTION and PARKED open the Composer. The Since band (engine addition 2), the consequence line under the buttons (engine addition 4), the empty Desk, the budget and failed states, pending rows with `^R` retry, and the discard and drop prompts. Below 100 columns: one list, ⏎ opens the preview.
4. Overview becomes the Floor. One `<Pipeline phase checks>` component with the five real phases, used everywhere. RUNNING and IN REVIEW become exclusive. Health only shows when it is stuck, looping or lost. Add the UP NEXT chain sentence. The Queue gets its three groups, the reason column (`needs 447✗` / `needs 452→`), the preview with gate, needs, unblocks, touches and the CHAIN picture, and `. show done`.
5. Fold thinking runs. Show time, verb and target columns. Make says and verdict bright. `w`, `v` and `i` become the stream filter tabs (all, worker, reviewer, verify, prompt), switched with `v`; `tab` stays next pane. Scrolling up pauses following. Steer opens the Composer inline and the sent message shows as a `you` line with its delivery state.
6. The story card gets Story, Criteria, Reviews, Runs and Diff sections, centred at 84 columns, with wrapping instead of truncation. The checklist leaves room 4 and becomes the overlay opened by `t`, with `y`/`n` for pass/fail.
7. Command palette (`:` and `ctrl-k`) and the `?` overlay from the registry. Settings and privacy live there. The Plan view (DIPO-449) and the Retro room (DIPO-453) mount inside the Frame, laid out as `07-plan.txt` and `06-retro.txt`.

## The only engine and contract additions
Ten, each added by the step that first shows it:
1. **Spend today** (step 2): on `office.summary`, for the header. `DayUsage.estimatedCost` (packages/contract/src/software.ts) already exists, optional and always estimated, on `dayUsage`; use it if the office read carries it, and add only what is missing.
2. **Last activity per office** (step 2): on `OfficeSummary`, for Offices' `idle N days`.
3. **Desk order with setup first** (step 3): `KNOWN_DESK_KINDS` puts the setup kinds (PROFILE) first; the TUI still never re-sorts.
4. **Since you last looked** (step 3): a summary in the office read for the Since band ("Since 09:41 · 1 merged · 2 new proposals · $4.10 spent").
5. **Optional `consequence: string` on `DeskAction`** (step 3): one code-built line saying what the action will do ("Accepting files it as a Backlog draft…"). Until then, the TUI keeps a small map from command to sentence.
6. **MERGE check and change stats** (step 3): the required-check count and state, and the change stats (files, +/−), from gh/git on the story PR read.
7. **PROPOSAL preview fields** (step 3): the story text, Why, Blocks, Size (tier) and "Raised … by <role> (<model>)", produced by the M3 idea audit (DIPO-452, {{M3-454}}); step 3 depends on both.
8. **Dependency chain** (step 4): the engine computes the chain from the dependency graph and sends it, for the Floor's UP NEXT sentence, the Queue's CHAIN picture and its "everything below N waits on the park" line, and the waiting state behind a bare `needs N`.
9. **Gate rule count** (step 4): `story.gate` returns the number of rules, for the Queue's `Gate ✓ N rules`.
10. **Diff read** (step 6): a diff read for the story's branch, for the reader's Diff tab.

No other engine facts are added: undo, expected times, proposal grouping, rework and "Worth a look" are dropped from M6 (spec.md, Maintainer decisions).
