---
id: DIPO-205
title: Keep a done report that arrives on the turn that reaches the turn cap
status: Refined
assignee: []
created_date: '2026-10-18 14:31'
updated_date: '2026-10-18 14:46'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/run/control.ts
  - packages/engine/src/run/control-turns.ts
  - packages/engine/src/run/control-endings.ts
  - packages/engine/src/run/caps.ts
  - packages/engine/src/run/outcome-exits.ts
  - packages/engine/src/run/verify-commit.ts
  - packages/engine/test/run/
priority: medium
type: bug
ordinal: 205000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: when the turn that crosses a run cap carries the worker's done report, the work that report describes ends up committed on the story branch, by the rule the maintainer chooses, instead of being left uncommitted in a budget-exceeded park.

Context: M1a run of DIPO-188 on 2026-10-18 (run_01M57FV2GAP0660HZ1S185XRDB, tier S, turn cap 60). The worker finished its work, ran verify and reported done, but the turn that carried the report took the run's engine total to 63 turns, so dipo parked the story budget-exceeded ("turn cap reached: 63 of 60 turns") and committed nothing. The maintainer side copied the uncommitted diff onto a finish branch by hand.

A run's turn cap fires on two paths, both in packages/engine/src/run/ unless named otherwise:

- The engine total (0008 sections 6 and 9), the path DIPO-188 hit. After each `usage` and `turn` event, onEventApplied in control.ts compares the stored totals with the caps through firedCap in caps.ts, which builds the detail "turn cap reached: <n> of <cap> turns", and marks the event. In onWorkerEvents the done turn is read first: control.ts sets lastReport and queues the turn to AfterTurns (control-turns.ts) for verify and commit. Then `#crossings.get(event)` finds the mark and calls #cap, which sets the run's ending synchronously through RunEndings.begin (control-endings.ts). When the queued turn runs, AfterTurns.#runTurn returns at `tracked.ending !== null`, so the done turn is never verified or committed.
- The CLI's `--max-turns` backstop. interpret.ts (packages/engine/src/workers/claude-cli/) puts `capped` on the turn event of an `error_max_turns` result ("turn cap (--max-turns) after <n> turns"); control.ts sends that turn to #cap and returns before it reads the turn's report. A worker exit at the backstop is decided by the `capped` case in outcome-exits.ts.

The engine-total crossing is shared by the three caps: firedCap returns the first of tokens, turns and minutes that is reached, so a done turn that crosses the token budget or the time cap is dropped the same way.

DIPO-105 parked on the other path, the CLI backstop ("turn cap (--max-turns) after 61 turns", 0020 context), and its work was not finished.

Decision records: the 0020 maintainer decision "Budget-exceeded resume" and 0020 section 4 resume a budget-exceeded park only with an explicit top-up (`--budget` with `--note`). Options A and B of the unknown change 0008 section 6, where the engine stops the worker at 100% of budgetTokens, maxTurns or maxMinutes, and need a dated 0020 note, since such a run no longer parks or needs a top-up. Options C and D need a dated 0020 note on what a budget-exceeded park leaves on the branch. The maintainer approves those notes; this story does not edit docs/decisions/.

References: they cover every option for now (C and D add the park-time commit in control-endings.ts and verify-commit.ts) and are revised to the chosen option once the unknown is answered.

```dipo
branch: "DIPO-205/done-report-at-turn-cap"
unknowns:
  - q: "When the turn that crosses a run cap also carries the worker's done report (DIPO-188 reported done on the turn that took it to 63 of 60 turns, and dipo parked it budget-exceeded with nothing committed), what should dipo do? (A) Treat the run as done, for the turn cap only (the engine total and the CLI --max-turns backstop): take the normal done path (verify-commit, then In Review) and record the crossed cap in the run's outcome. (B) The same as A, for every cap whose crossing turn carries a done report: tokens, turns and minutes, since the crossing code in caps.ts and control.ts is shared. (C) Still park budget-exceeded, for the turn cap only, but commit the worker's work to the story branch first, so a resume with a top-up or a hand finish starts from that commit. (D) The same as C, for every cap whose crossing turn carries a done report. A and B change 0008 section 6 (the engine stops the worker at 100% of budgetTokens, maxTurns or maxMinutes) and need a dated note on the 0020 maintainer decision 'Budget-exceeded resume' and 0020 section 4, since such a run no longer parks or needs a top-up. C and D need a dated 0020 note on what a budget-exceeded park leaves on the branch."
    status: "open"
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a done report on the turn that crosses the engine-total turn cap follows the chosen option and leaves the worker's work committed on the story branch"
    - kind: "automated"
      check: "(engine) a done report on a turn with `capped` from the CLI --max-turns backstop follows the same option"
    - kind: "automated"
      check: "(engine) a cap-crossing turn without a done report still parks budget-exceeded with its cap detail"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A run whose cap-crossing turn carries a done report follows the option chosen for the unknown and leaves the worker's work committed on the story branch, with a test in packages/engine/test/run/ that drives RunControl with such a turn on the engine-total crossing
- [ ] #2 A turn that carries a done report and `capped` from the CLI --max-turns backstop follows the same option, with its own test in packages/engine/test/run/
- [ ] #3 A cap-crossing turn without a done report still parks budget-exceeded with its cap detail ("turn cap reached: <n> of <cap> turns" on the engine total), and the existing cap tests in packages/engine/test/run/ pass unchanged
<!-- AC:END -->
