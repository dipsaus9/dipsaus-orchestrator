---
id: DIPO-222
title: Cap a run whose capped done turn the finisher lets continue
status: Refined
assignee: []
created_date: '2026-10-19 23:02'
updated_date: '2026-10-19 23:03'
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
- [ ] #1 When the finisher answers continue for a turn queued with a crossed cap and no other ending has claimed the run, run control ends the run for that cap as a crossing turn without a done report does: intent cap, park budget-exceeded with cause build and the cap detail, and no cap run_steps row
- [ ] #2 Tests show a done report on the turn that reaches max_turns parking budget-exceeded in a session run and in a story run without a worktree, with no In Review end
- [ ] #3 The cap run_steps row of a capped done turn is written in the same transaction as the end of the run: the In Review end in verify-commit.ts, or the park the done path ends in; the separate write in #cappedDone and its warn-only failure are removed
- [ ] #4 Tests in packages/engine/test/run/verify-commit.test.ts show no cap run_steps row while the capped done path's verify runs, exactly one after the In Review end and exactly one after the verify-failing park, and the DIPO-205 tests there keep passing
<!-- AC:END -->
