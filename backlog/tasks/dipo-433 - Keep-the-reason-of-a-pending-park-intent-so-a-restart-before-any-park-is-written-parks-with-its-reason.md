---
id: DIPO-433
title: >-
  Keep a pending park's reason, so a restart before the park is written parks
  with it
status: Refined
assignee: []
created_date: '2026-11-02 14:12'
updated_date: '2026-11-02 14:33'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/run/outcome-exits.ts
  - packages/engine/src/run/outcome-types.ts
  - packages/engine/src/run/control-endings.ts
  - packages/engine/src/run/control-types.ts
  - packages/engine/src/run/control.ts
  - packages/engine/src/run/control-turns.ts
  - packages/engine/src/run/fix-rounds.ts
  - packages/engine/src/run/outcome-sessions.ts
  - packages/engine/src/run/outcome-turns.ts
  - packages/engine/src/create/compose.ts
  - packages/engine/src/run/outcome-restart.ts
  - packages/engine/test/run/
priority: medium
type: bug
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: when dipo has decided to park a story and the daemon restarts before the park is written, the story still parks with the same reason, detail and park facts, for every park that goes through a park intent.

Proposed by the worker of DIPO-430 and accepted by the maintainer on 2026-11-02 (proposal a07157b4, DRAFT-12). After a restart, a run whose newest agent ended undecided is decided from its intent in `#byIntent` (packages/engine/src/run/outcome-exits.ts about line 147). Since DIPO-430 a `park` intent tagged `worker-question <text>` parks `ambiguous-spec` with its question; any other park intent falls back to `resolve(... outcomeOf(intent))`, which loses its park reason, and a `RunEnding`'s `capStep` (budget-exceeded) and `resumeOnLift` (plan-limit) are not in the intent at all. The intent detail is written in packages/engine/src/run/control-endings.ts (about line 496, `ending.intentDetail ?? ending.detail`); tags are the first space-delimited word of the detail (`INTENT_TAGS`, `intentTag` in packages/engine/src/run/outcome-types.ts). Park intents are written from control.ts, control-turns.ts, fix-rounds.ts, outcome-exits.ts, outcome-sessions.ts, outcome-turns.ts and create/compose.ts. The pause and plan-limit tags (`LEGACY_PAUSE_TAG`, `LEGACY_PLAN_LIMIT_TAG`) are legacy: nothing writes them, and only `#parkPaused` (outcome-restart.ts) reads them.

Design: in scope are intents of kind `park` only; `stop` and `cap` intents keep today's restart handling. A park intent's detail carries a new tag, `park-reason:<reason>`, followed by an encoded tail with the park detail, `capStep` and `resumeOnLift` when they are set (an encoding the builder picks, for example a small JSON object after the tag, that no existing tag word can collide with). `#byIntent` reads it back and parks with the stored reason, detail, `capStep` and `resumeOnLift`. The `worker-question` tag of DIPO-430 keeps working unchanged, an untagged or unknown detail written by an older binary falls back as today, and `#parkPaused` is left untouched. One intent format (0001). 0005, 0020.

```dipo
branch: "DIPO-433/park-intent-reason"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a park intent stores its reason, capStep and resumeOnLift in a tagged detail, and #byIntent parks with them after a restart, keeping the worker-question tag and old intents working"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 For each park reason written through a `park` intent that `#byIntent` can reach after a restart, a test that stops after the intent and restarts parks the story with that reason and detail; the PR lists the reasons covered and, for any it cannot reach, why
- [ ] #2 A budget-exceeded park keeps its `capStep` and a plan-limit park keeps its `resumeOnLift` across that restart, shown by tests
- [ ] #3 A `worker-question` intent (DIPO-430) still parks with its question, and an intent written before this change (no `park-reason` tag) still decides as today, shown by tests
- [ ] #4 `stop` and `cap` intents and `#parkPaused` behave as today, shown by the existing tests
<!-- AC:END -->
