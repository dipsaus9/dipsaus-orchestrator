---
id: DIPO-272
title: >-
  Carry the worker's part, done, question, blocked and proposal messages through
  the box door
status: Refined
assignee: []
created_date: '2026-10-21 13:44'
updated_date: '2026-10-21 13:54'
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
- [ ] #1 A small command in the box (dipo-part "message") hands a part to dipo; dipo reads it from the box, never the other way round
- [ ] #2 Story done, question, blocked and proposal arrive in the worker's structured report
- [ ] #3 Every message is size-limited, parsed against a strict schema and cleaned of terminal control characters before it is stored or shown
- [ ] #4 The worker contract describes the messages and drops the write-only-these-paths, no-git and no-cd rules (0014 amendment of 2026-10-21)
- [ ] #5 A question from the box goes through the live-or-park rule of DIPO-279
<!-- AC:END -->
