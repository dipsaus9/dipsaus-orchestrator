---
id: DIPO-235
title: End a capped done turn at its cap when the finisher throws
status: Done
assignee: []
created_date: '2026-10-20 10:40'
updated_date: '2026-10-20 11:22'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/run/control-turns.ts
  - packages/engine/test/run/control.test.ts
priority: medium
type: bug
ordinal: 235000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a done turn that crossed a cap ends the run at that cap when the finisher's afterTurn throws, instead of leaving tracked.capped set and the run going on with no cap.

Context: DIPO-222 (PR #261). #cappedDone in packages/engine/src/run/control.ts sets tracked.capped to the crossed cap, disarms the cap tick and queues the turn with it; while tracked.capped is set, checkCaps, onEventApplied and #checkCaps compare nothing. In packages/engine/src/run/control-turns.ts, #runTurn awaits #finishTurn, which awaits finisher.afterTurn (verify and commit, packages/engine/src/run/verify-commit.ts); only when that returns continue does the DIPO-222 fallback begin capEnding (packages/engine/src/run/control-endings.ts). When afterTurn throws, #finishTurn settles its claim with null in its finally and rethrows, #runTurn rejects before the fallback, and background in AfterTurns.queue logs "verify and commit after a turn failed". The run stays tracked with capped set and no cap tick, so the worker can go on with no cap. A throw after the finisher claimed the end (tracked.ending is the finisher's own claim) is not part of this story. The DIPO-222 tests are in packages/engine/test/run/control.test.ts ("a capped done turn the finisher lets continue").

```dipo
branch: "DIPO-235/cap-when-finisher-throws"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a finisher whose afterTurn throws on the capped done turn: the stop op is sent, the story parks budget-exceeded with the cap detail, and one warn line names the run, the cap and the reason; the test fails without the fix"
    - kind: "automated"
      check: "(unit) the same throwing finisher on a turn that crossed no cap: no cap ending begins and background logs verify and commit after a turn failed, as today"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 In #runTurn of packages/engine/src/run/control-turns.ts, when the turn carries a crossed cap and #finishTurn rejects, the error is logged through the run control's warn with the run, the cap and the reason, and, while tracked.ending is null, the run begins capEnding with the crossed cap and its detail, the ending the DIPO-222 fallback begins; that queued turn does not reject
- [x] #2 A turn that carries no crossed cap and whose #finishTurn rejects behaves as today: the turn rejects and background logs "verify and commit after a turn failed"
- [x] #3 Tests in packages/engine/test/run/control.test.ts, beside the DIPO-222 tests, use a finisher whose afterTurn throws: on the capped done turn the stop op is sent, the story parks budget-exceeded with the cap detail and one warn line is written, and the test fails without the fix; on a turn with no crossed cap no cap ending begins
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M5CG7NEVRD5PEZJ0XQ026BDG (Haiku, 13 turns, about $0.01, 1 min) reported done, In Review. Its `DIPO_TMP=$TMPDIR bun test ...` call was refused by the DIPO-194 Bash guard with the intended reason (live check of DIPO-194); no other denial, no write outside the References. When the finisher throws on a capped done turn and no ending holds the run, #runTurn warns 'verify and commit after a capped turn failed; ending at the cap' and ends the run with the cap ending, so the run is never left uncapped; an uncapped throw behaves as before, and a throw after the finisher claimed the end still rethrows. Review passed; advisory, not done: the capped-throw test does not assert that no cap step row is written. Verify outside the sandbox: exit 0, 4023 tests; DIPO_TEST_CI=1 run tests pass (392).
<!-- SECTION:NOTES:END -->
