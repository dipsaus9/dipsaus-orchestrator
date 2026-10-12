---
id: DIPO-55
title: Follow a running agent's live output in the TUI
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 09:52'
labels:
  - 'tier:M'
  - test-before-merge
milestone: m-0
dependencies:
  - DIPO-54
  - DIPO-49
  - DIPO-51
references:
  - packages/tui/src/
  - packages/tui/test/
documentation:
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0009-tui.md
priority: high
type: feature
ordinal: 55000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: Enter on a running story opens the live agent detail: facts on the left (phase, health, loop, verify, criteria, usage split, budget, signals) and the worker or verify output tail on the right, with scroll-back through `work.outputRange` and `X` to stop the worker after confirmation.

Context: steer, pause, reassign, discard and answer keys are M1. References: 0009 sections 4 (live agent detail layout, `cw`/`cr` usage), 5 (stop with confirmation), 6 (Esc back), 9 (only visible lines in state); 0005 sections 5 (`work.output` byte ranges), 7 (`work.outputRange`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-55/follow-running-agent-s-live-output-tui"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(TUI) detail frame from a golden log with output; scroll-up issues a `work.outputRange` read."
    - kind: "automated"
      check: "(TUI) `X` then `y` sends `work.stop` with the story id."
    - kind: "manual"
      check: "in a scratch office with one Ready fixture story, run `dipo run <ID>`, open `dipo tui`, select the story in the overview (`1`) and press Enter; after the worker reports done press `v`, then press `X` and answer no"
      expect: "worker output streams in the right pane within a second of the worker writing it; after `v` the verify output is shown; answering no to `X` leaves the run going; Esc returns to the overview."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The detail header shows story, title, role, tier, model and run id, plus `[follow]` when the host is follow-only.
- [ ] #2 The facts panel shows phase, health, loop over cap, verify, criteria with checkboxes, usage in, out, cache writes, cache reads and turns, budget bar, and active signals with their start time.
- [ ] #3 The output pane shows `work.output` for the selected source, `w` for worker and `v` for verify, follows the tail, and End returns to following.
- [ ] #4 Scrolling up fetches earlier text with `work.outputRange`; React state holds only the visible lines.
- [ ] #5 `X` asks "worker ends, branch kept, story parks as stopped" and sends `work.stop` on yes.
- [ ] #6 Esc returns to the previous view.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S39 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
