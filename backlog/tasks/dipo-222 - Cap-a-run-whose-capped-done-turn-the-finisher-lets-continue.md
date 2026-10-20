---
id: DIPO-222
title: Cap a run whose capped done turn the finisher lets continue
status: Done
assignee: []
created_date: '2026-10-19 23:02'
updated_date: '2026-10-20 09:47'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/run/control.ts
  - packages/engine/src/run/control-turns.ts
  - packages/engine/src/run/control-endings.ts
  - packages/engine/src/run/verify-commit.ts
  - packages/engine/test/run/verify-commit.test.ts
  - packages/engine/test/run/control.test.ts
  - packages/engine/src/run/park.ts
priority: high
type: bug
ordinal: 222000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a done report on the turn that crosses a cap, in a run the finisher does not take to the done path, ends the run at the cap as before DIPO-205, and the cap's run_steps row is written with the end of the run, never beside it.

Context: review of DIPO-205 (PR #243). 0008 section 6 amendment of 2026-10-19: a done report on the crossing turn takes the normal done path and the run records the crossed cap; a crossing turn without the done path still stops the worker at 100%. In packages/engine/src/run/control.ts, #cappedDone sets tracked.capped, which turns off onEventApplied, checkCaps and the cap tick for the run, disarms the tick and queues the turn with the crossed cap. VerifyCommit.afterTurn (packages/engine/src/run/verify-commit.ts) answers continue at once for a session run or a story run without a worktree or story, and AfterTurns.#runTurn (packages/engine/src/run/control-turns.ts) then does nothing, so the run goes on with no cap at all. #cappedDone also writes the cap step in its own office.immediate before verify and only logs a failure ("recording the cap a done turn crossed failed"), so a run can end In Review without its cap row.

```dipo
branch: "DIPO-222/cap-capped-done-finisher-skips"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a done report on the turn that reaches max_turns in a session run, and in a story run without a worktree, parks budget-exceeded with cause build and the turn cap detail, with no In Review end and no cap run_steps row"
    - kind: "automated"
      check: "(unit) no cap run_steps row exists while the capped done path's verify runs; exactly one exists after the In Review end and after the verify-failing park"
    - kind: "automated"
      check: "(unit) the DIPO-205 tests in verify-commit.test.ts keep passing"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 When the finisher answers continue for a turn queued with a crossed cap and no other ending has claimed the run, run control ends the run for that cap as a crossing turn without a done report does: intent cap, park budget-exceeded with cause build and the cap detail, and no cap run_steps row
- [x] #2 Tests show a done report on the turn that reaches max_turns ending on the cap with no In Review end and no cap row: a session run (the finisher answers continue for it) gets the cap intent and the stop, as a crossing turn without a done report does, since a session run cannot park; a story run whose finisher answers continue parks budget-exceeded (a story run always has a worktree, so that answer comes only when another ending holds the run)
- [x] #3 The cap run_steps row of a capped done turn is written in the same transaction as the end of the run: the In Review end in verify-commit.ts, or the park the done path ends in; the separate write in #cappedDone and its warn-only failure are removed
- [x] #4 Tests in packages/engine/test/run/verify-commit.test.ts show no cap run_steps row while the capped done path's verify runs, exactly one after the In Review end and exactly one after the verify-failing park, and the DIPO-205 tests there keep passing
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M5CA3ZH7NEC7KWMP6QGR3CFP (Sonnet, 63 turns, about $0.82, 6 min) reported done, In Review; one sed -i was auto-denied (G7, before the DIPO-181 binary). No write outside the References. When the finisher answers continue for a capped done turn, the run now falls back to the cap ending (capEnding, shared with #cap); the cap run_steps row is written in the transaction that ends the run In Review or parks it (no separate write, no warn-only path). Review blocked on criterion 2's 'story run without a worktree': the runs table's check makes a story run always have a worktree, so that state cannot exist; the criterion is reworded to the buildable cases (a session run gets the cap intent and stop, since it cannot park; a story run whose finisher answers continue parks budget-exceeded) and the control.test.ts case is renamed to say what it covers. Advisories, gap list: a finisher that throws on a capped done turn still leaves the run uncapped. Verify outside the sandbox: exit 0, 3937 tests; DIPO_TEST_CI=1 run and daemon tests pass (618).
<!-- SECTION:NOTES:END -->
