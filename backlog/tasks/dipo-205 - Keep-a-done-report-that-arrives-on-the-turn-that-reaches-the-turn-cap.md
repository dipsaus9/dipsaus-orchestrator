---
id: DIPO-205
title: Keep a done report that arrives on the turn that crosses a run cap
status: In Progress
assignee: []
created_date: '2026-10-18 14:31'
updated_date: '2026-10-19 22:04'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/run/
  - packages/engine/test/run/
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/test/db/
priority: medium
type: bug
ordinal: 205000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: when the turn that crosses a run cap carries the worker's done report, the run takes the normal done path, so the work that report describes ends up committed on the story branch instead of being left uncommitted in a budget-exceeded park.

Context: M1a run of DIPO-188 on 2026-10-18 (run_01M57FV2GAP0660HZ1S185XRDB, tier S, turn cap 60). The worker finished its work, ran verify and reported done, but the turn that carried the report took the run's engine total to 63 turns, so dipo parked the story budget-exceeded ("turn cap reached: 63 of 60 turns") and committed nothing. The maintainer side copied the uncommitted diff onto a finish branch by hand.

A run's turn cap fires on two paths, both in packages/engine/src/run/ unless named otherwise:

- The engine total (0008 sections 6 and 9), the path DIPO-188 hit. After each `usage` and `turn` event, onEventApplied in control.ts compares the stored totals with the caps through firedCap in caps.ts, which builds the detail "turn cap reached: <n> of <cap> turns", and marks the event. In onWorkerEvents the done turn is read first: control.ts sets lastReport and queues the turn to AfterTurns (control-turns.ts) for verify and commit. Then `#crossings.get(event)` finds the mark and calls #cap, which sets the run's ending synchronously through RunEndings.begin (control-endings.ts). When the queued turn runs, AfterTurns.#runTurn returns at `tracked.ending !== null`, so the done turn is never verified or committed.
- The CLI's `--max-turns` backstop. interpret.ts (packages/engine/src/workers/claude-cli/) puts `capped` on the turn event of an `error_max_turns` result ("turn cap (--max-turns) after <n> turns"); control.ts sends that turn to #cap and returns before it reads the turn's report. A worker exit at the backstop is decided by the `capped` case in outcome-exits.ts.

The engine-total crossing is shared by the three caps: firedCap returns the first of tokens, turns and minutes that is reached, so a done turn that crosses the token budget or the time cap is dropped the same way.

DIPO-105 parked on the other path, the CLI backstop ("turn cap (--max-turns) after 61 turns", 0020 context), and its work was not finished.

Decision records: the 0020 maintainer decision "Budget-exceeded resume" and 0020 section 4 resume a budget-exceeded park only with an explicit top-up (`--budget` with `--note`). Options A and B of the unknown change 0008 section 6, where the engine stops the worker at 100% of budgetTokens, maxTurns or maxMinutes, and need a dated 0020 note, since such a run no longer parks or needs a top-up. Options C and D need a dated 0020 note on what a budget-exceeded park leaves on the branch. The maintainer approves those notes; this story does not edit docs/decisions/.

References: packages/engine/src/run/ and its tests for the done path and the park; packages/engine/src/db/migrations/, packages/engine/src/db/schema.ts and packages/engine/test/db/ (its migration test) because recording the crossed cap as a run_steps row needs a new kind in the run_steps kind check (migration 0034).

Decided (maintainer, 2026-10-19; 0008 and 0020 Amendments of 2026-10-19, DIPO-205): every cap whose crossing turn carries a done report, and the CLI backstop turn with a done report, takes the normal done path (verify-commit, then In Review), and the crossed cap is recorded as a durable run fact: a run_steps row (appendRunStep) of a new kind cap with the cap name and its detail; the done path's own end kinds (in-review, done) stay as they are, and OUTCOME_ENDS.capped stays the budget-exceeded park's. If that verify fails, no turn is left for feedback: the story parks verify-failing with the new park cause capped (PARK_CAUSES in packages/engine/src/run/park.ts) and the failure as its detail; capped wins over loops when the same verify also reaches the loop cap. A later round the engine sends back to the worker after a capped done path (a review or CI fix round, a conflict hand-off) whose caps are still used up parks budget-exceeded before any worker session starts (maintainer, 2026-10-19). No check does this today: RunControl checks caps only after usage and turn events and on its 60 s tick (CAP_TICK_MS), and RunResumer gives the CLI at least one turn, so this story adds one shared pre-start cap check in packages/engine/src/run/ that Places.drain (places.ts) runs before it calls the starter of a worker-place fix or conflict wait (START_KINDS.fix, START_KINDS.conflict); review sessions in the reviewer place have their own caps and are not checked here. No fix or conflict starter is registered on main yet (DIPO-148 and DIPO-149 add them), so the check is tested with a recording starter. feedback_items does not exist before DIPO-148, which stores a fix round's feedback_items rows before this check runs, so a top-up resume can still send them (DIPO-156); this story does not depend on DIPO-148. A maintainer resume of such a run is refused with resume.capReached (0020 section 1 step 1), not parked. The resume of that park (note plus a +50% top-up grant) is DIPO-157's. A live CLI backstop result (error_max_turns) carries no structured_output, so the backstop case is tested with a synthetic turn event. This story does not edit docs/decisions/.

```dipo
branch: "DIPO-205/done-report-at-turn-cap"
unknowns:
  - q: "When the turn that crosses a run cap also carries the worker's done report (DIPO-188 reported done on the turn that took it to 63 of 60 turns, and dipo parked it budget-exceeded with nothing committed), what should dipo do? (A) Treat the run as done, for the turn cap only (the engine total and the CLI --max-turns backstop): take the normal done path (verify-commit, then In Review) and record the crossed cap in the run's outcome. (B) The same as A, for every cap whose crossing turn carries a done report: tokens, turns and minutes, since the crossing code in caps.ts and control.ts is shared. (C) Still park budget-exceeded, for the turn cap only, but commit the worker's work to the story branch first, so a resume with a top-up or a hand finish starts from that commit. (D) The same as C, for every cap whose crossing turn carries a done report. A and B change 0008 section 6 (the engine stops the worker at 100% of budgetTokens, maxTurns or maxMinutes) and need a dated note on the 0020 maintainer decision 'Budget-exceeded resume' and 0020 section 4, since such a run no longer parks or needs a top-up. C and D need a dated 0020 note on what a budget-exceeded park leaves on the branch."
    status: "resolved"
    answer: "B (maintainer, 2026-10-19): for every cap (tokens, turns, minutes, and the CLI --max-turns backstop), a done report on the crossing turn takes the normal done path and the outcome records the crossed cap. If that done path's verify fails, the story parks verify-failing with cause capped (follow-up answer B); its resume needs a note and raises the crossed cap by the default +50% top-up as a budget grant (follow-up answer A, delivered by DIPO-157). Notes: 0008 and 0020 Amendments, 2026-10-19, DIPO-205."
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a done report on the turn that crosses the engine-total turn cap, and one on the turn that crosses the token cap, take the done path to In Review and record a run_steps row of kind cap naming the crossed cap"
    - kind: "automated"
      check: "(engine) a synthetic turn event with a done report and `capped` from the CLI --max-turns backstop takes the same done path"
    - kind: "automated"
      check: "(engine) a failed verify on that done path parks verify-failing with cause capped and the failure as detail, sends no feedback turn, and capped wins over loops at the loop cap"
    - kind: "automated"
      check: "(engine) a cap-crossing turn without a done report still parks budget-exceeded with its cap detail"
    - kind: "automated"
      check: "(unit) the shared pre-start cap check: a run whose runCaps are reached, waiting in the worker place as a fix start and as a conflict start, parks budget-exceeded with cause build and the cap detail when Places.drain runs, and the recording starter is never called; a run under its caps reaches its starter"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A run whose turn crosses budgetTokens, maxTurns or maxMinutes on the engine total and carries a done report takes the normal done path (verify-commit, then In Review) instead of parking, and a run_steps row of kind cap records the crossed cap and its detail; a test in packages/engine/test/run/ drives RunControl with such a turn for the turn cap and for the token cap and reads the row back
- [ ] #2 A turn with a done report and `capped` from the CLI --max-turns backstop takes the same done path, tested with a synthetic turn event in packages/engine/test/run/
- [ ] #3 When the verify of that done path fails, the story parks verify-failing with park cause capped and the verify failure as its detail, no feedback turn is sent, and capped wins over loops when the same verify reaches the loop cap; a test shows the park, its cause and that no worker message follows
- [ ] #4 A cap-crossing turn without a done report still parks budget-exceeded with its cap detail ("turn cap reached: <n> of <cap> turns" on the engine total), and the existing cap tests in packages/engine/test/run/ pass unchanged
- [ ] #5 One shared pre-start cap check in packages/engine/src/run/ runs in Places.drain before the starter of a worker-place fix or conflict wait (START_KINDS.fix, START_KINDS.conflict) is called: when the run's runCaps are already reached, the story parks budget-exceeded with cause build and the cap detail and the starter is not called; a unit test stores a capped run's fix wait and conflict wait with waitForPlace, drains with a recording starter, and shows the park and that the starter was never called, and that a run under its caps reaches its starter
<!-- AC:END -->
