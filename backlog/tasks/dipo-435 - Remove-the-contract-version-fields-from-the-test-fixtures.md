---
id: DIPO-435
title: >-
  Drop the removed contract version fields from the contract fixtures and refuse
  stale fixture fields
status: Ready
assignee: []
created_date: '2026-10-31 08:13'
updated_date: '2026-11-03 07:14'
labels:
  - 'tier:S'
milestone: m-2
dependencies: []
references:
  - packages/contract/test/fixtures.ts
  - packages/contract/src/index.test.ts
  - packages/contract/src/software.ts
  - packages/contract/src/office.ts
  - packages/engine/src/log/logger.ts
priority: low
type: chore
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the contract's test fixtures show only what the contract has, and a field the contract drops can no longer stay behind in them unnoticed.

Filed from DRAFT-4 (proposed by the worker of DIPO-385). The fixture test in packages/contract/src/index.test.ts parses each fixture with zod objects, which drop unknown keys, so stale fields pass. Six such keys are in packages/contract/test/fixtures.ts: `engine.hello` args `contract` and result `contract` and `capabilities` (about lines 636-645; DIPO-355 removed contract versioning, and `engine.hello` in packages/contract/src/software.ts about line 221 takes only `client`); `commands.describe` result `commands[0].since` and `reads[0].since` (about lines 659 and 670; DIPO-355 dropped `since`); and `story.losses` result `files` (about line 320; the schema in packages/contract/src/office.ts about lines 541-545 has none). The comment above the secret name endings in packages/engine/src/log/logger.ts (about lines 29-30) also still names `engineToken` and `engine_token` as examples, though DIPO-369 removed that token (DRAFT-1, archived, asked for this), and cites an ADR by amendment date.

Design: the six keys go. The fixture test also checks, recursively, that every key of a fixture's input appears in what its schema parsed, for command and read args and results and for event data, so the next removed field fails the test. That works with the contract's schemas: message schemas have no transforms and no defaults outside the envelope's `confirmed`, `z.record` and `z.unknown()` keep their keys, and a union returns the member that matched. The logger comment names only current examples and cites the ADR by number only (0003). No contract change, so `bun run contract:schema` leaves packages/contract/schema/ as it is. 0005.

```dipo
branch: "DIPO-435/fixtures-no-stale-fields"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(contract) the six stale fixture keys are gone, and the fixture test fails on a fixture key its schema does not know"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The six stale keys (`engine.hello` args `contract`, result `contract` and `capabilities`; `commands.describe` `since` twice; `story.losses` `files`) are gone, shown by the diff
- [ ] #2 The fixture test fails on a fixture key its schema does not know, for commands, reads and events and also in nested objects, shown by a test with a planted stale key, and every current fixture passes
- [ ] #3 logger.ts's comment no longer names `engineToken` or `engine_token` and cites the ADR by number only, and `bun run contract:schema` leaves no change
<!-- AC:END -->
