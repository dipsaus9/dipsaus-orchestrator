---
id: DIPO-272
title: >-
  Carry the worker's part, done, question, blocked and proposal messages through
  the box door
status: Done
assignee: []
created_date: '2026-10-21 13:44'
updated_date: '2026-10-21 20:24'
labels:
  - 'tier:M'
  - cutover
  - box
milestone: m-1
dependencies:
  - DIPO-271
  - DIPO-279
references:
  - packages/engine/src/box/door.ts
  - packages/engine/src/workers/claude-cli/
  - packages/engine/src/prompts/contract/
  - packages/engine/test/box/door.test.ts
  - packages/engine/test/prompts/golden/
  - packages/engine/src/box/workers.ts
  - packages/engine/src/box/index.ts
  - packages/engine/src/workers/types.ts
  - packages/engine/src/prompts/templates.ts
  - packages/engine/src/run/prompts.ts
  - packages/engine/src/run/launch.ts
  - packages/engine/src/run/resume.ts
  - packages/engine/src/run/control.ts
  - packages/engine/src/run/control-types.ts
  - packages/engine/src/run/compose.ts
  - packages/engine/src/run/live-question.ts
  - packages/engine/src/hooks/permissions.ts
  - packages/engine/src/hooks/questions.ts
  - packages/daemon/src/runs.ts
  - packages/engine/test/box/workers.test.ts
  - packages/engine/test/workers/golden/
  - packages/engine/test/prompts/system.test.ts
  - packages/engine/test/run/start.test.ts
  - packages/engine/test/hooks/worker-questions.test.ts
  - packages/engine/src/prompts/task/
  - packages/engine/src/prompts/assemble.ts
  - packages/engine/src/prompts/contract.ts
  - packages/engine/src/run/park.ts
  - packages/engine/test/prompts/task.test.ts
  - packages/engine/test/run/reattach.test.ts
priority: high
type: feature
ordinal: 261000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the worker talks to dipo only through checked messages: part done (with a message) through a small command in the box, and story done, question, blocked and proposal in its report; every message is size-limited, strictly parsed and treated as text.

Context: Decision 0021 (worker isolation, DIPO-263) and the probe results of DIPO-264 (tools/box-probe/RESULTS.md and the 0021 amendment of 2026-10-21).

```dipo
branch: "DIPO-272/box-door-messages"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A small command in the box (dipo-part "message") hands a part to dipo; dipo reads it from the box, never the other way round
- [x] #2 Story done, question, blocked and proposal arrive in the worker's structured report
- [x] #3 Every message is size-limited, parsed against a strict schema and cleaned of terminal control characters before it is stored or shown
- [x] #4 The worker contract describes the messages and drops the write-only-these-paths, no-git and no-cd rules (0014 amendment of 2026-10-21)
- [x] #5 A question from the box goes through the live-or-park rule of DIPO-279
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- The live worker question (a blocked report's question asked live while a TUI is connected, else park) runs in run control for every developer run, so it applies to Mac runs too, not only box runs. DIPO-159 (answer before park) should build on it: kind question rows, PermissionAsks.askWorker, the held answer of a question its park took over.
- Part messages are read from the box, checked, recorded in the run directory (door-parts.ndjson) and acknowledged, but not committed: delivering and committing them is DIPO-273, through BoxDoor's onPart. Box runs stay held until DIPO-275.
<!-- SECTION:NOTES:END -->
