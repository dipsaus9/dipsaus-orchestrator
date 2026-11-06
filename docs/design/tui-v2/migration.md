# Migration: today's TUI → v2

Each step is a story dipo can run on its own (filed as M6 stories). Dependency: DIPO-443 (one part per mode), which is done. Every step's screens must match `docs/design/tui-v2/designs/dipo-ux-spec.html` exactly; the text mocks in `screens/` are the same screens in text, and `spec.md` lists the open questions to build around.

| # | Step | Tier | Needs | Screens | Files |
|---|---|---|---|---|---|
| 1 | Foundations: nine colour roles (plus shade), Frame, action registry, Composer | M | none | `17-themes.txt`; the Frame bands of every screen; the widen message | colour.tsx → `role`; screen.tsx → `<Frame>`; keys.ts → registry with label/when/priority; footer.ts reads registry; + composer.tsx |
| 2 | Quiet down: clear the RunResult panel, ticker, header diet, key remap, daemon states, Offices | S | 1 | headers and footers of every screen; `08-offices.txt`; offline, recovering and daemon stopped in `12-states.txt` | app.tsx panel; views.tsx Header; keys.ts; offices view |
| 3 | Desk with preview and kind groups | M | 2 | `14-desk-proposals.txt`, `01-desk.txt`, `11-desk-previews.txt`, `15-budget-and-failed.txt`, `16-narrow.txt`; empty Desk, pending, discard and drop in `12-states.txt` | desk.tsx split; + desk-preview.tsx; keys.ts rowKeys |
| 4 | Floor, Queue and `<Pipeline>` | M | 1 | `02-floor.txt`, `05-queue.txt` | overview.tsx; queue.tsx; + pipeline.tsx; run.tsx |
| 5 | Run stream as a table | M | 4 | `03-run.txt` | output.ts folding; detail.tsx tabs; `<Static>` for finished lines |
| 6 | Story reader and test overlay | S | 3 | `04-story-reader.txt`, `10-test-overlay.txt` | story-card.tsx; checklist.tsx → overlay; detail.tsx |
| 7 | Palette, keys overlay, Plan and Retro rooms | M | 1 (+ DIPO-449/453) | `09-palette.txt`, `13-keys-overlay.txt`, `07-plan.txt`, `06-retro.txt` | + palette.tsx; + help.tsx; settings.tsx → palette |

## What each step builds
1. `Colored` takes a role instead of a raw colour (`color?: string` → `role?: Role`): the nine roles of `roles.json` plus shade, each on its ANSI slot, the truecolor Classical theme as an opt-in, theme detection (OSC 11, `COLORFGBG`, dark), NO_COLOR (sel equals bg, only `▌` marks the row) and `--ascii` twins. A `<Frame>` owns header, rooms, body, ticker and keys, and shows "Widen the terminal to at least 60 columns" below 60 columns. The key table grows label, when() and priority, and footer, help and palette read from it. Add the `<Composer>` multi-line input. Nothing visible changes yet apart from the colours.
2. Clear the RunResult skipped block after the next key and send it to the ticker. Move privacy words out of the header; the header shows `dipo / <office>`, the daemon dot and word, spend today and the time. Remap keys per `keymap.json` (`changedFromToday`). Offline, recovering and daemon stopped get the bodies and header chips of `12-states.txt`. Offices gets the NEEDS YOU first column, state glyphs and the TODAY bar.
3. Split the list and preview at 100 columns or wider. Kind group headers in engine order. The preview shows detail, blocks, since, hand, buttons for bound actions (first one primary) and cli lines for unbound ones. Same-title proposals group together. NEXT UP gets y/n. QUESTION and PARKED open the Composer. The Since band, the empty Desk, the budget and failed states, pending rows with `^R` retry, and the discard and drop prompts. Below 100 columns: one list, ⏎ opens the preview.
4. Overview becomes the Floor. One `<Pipeline phase checks>` component with the five real phases, used everywhere. RUNNING and IN REVIEW become exclusive. Health only shows when it is stuck, looping or lost. Add the UP NEXT chain sentence. The Queue gets its three groups, the reason column (`needs 447✗` / `needs 452→`), the preview with gate, needs, unblocks, touches and the CHAIN picture, and `. show done`.
5. Fold thinking runs. Show time, verb and target columns. Make says and verdict bright. `w`, `v` and `i` become the stream filter tabs (all, worker, reviewer, verify, prompt). Scrolling up pauses following. Steer opens the Composer inline and the sent message shows as a `you` line with its delivery state.
6. The story card gets Story, Criteria, Reviews, Runs and Diff sections, centred at 84 columns, with wrapping instead of truncation. The checklist leaves room 4 and becomes the overlay opened by `t`, with `y`/`n` for pass/fail.
7. Command palette (`:` and `ctrl-k`) and the `?` overlay from the registry. Settings and privacy live there. Plan (DIPO-449) and Retro (DIPO-453) mount as rooms inside the Frame, laid out as `07-plan.txt` and `06-retro.txt`.

## The only contract additions
1. Spend today on `office.summary` (for the header). It may already be derivable from `dayUsage`, so check before adding.
2. Optional `consequence: string` on `DeskAction`: one code-built line saying what the action will do ("Accepting files it as a Backlog draft…"). Until then, the TUI keeps a small map from command to sentence.

The open questions in `spec.md` (undo, "expected ~HH:MM", the Since summary, proposal grouping, Worth a look) need engine facts that do not exist yet; no step adds them without the maintainer's answer.
