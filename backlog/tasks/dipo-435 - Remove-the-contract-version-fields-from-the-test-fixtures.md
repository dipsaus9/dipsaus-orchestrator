---
id: DIPO-435
title: >-
  Drop the removed contract version fields from the contract fixtures and refuse
  stale fixture fields
status: Refined
assignee: []
created_date: '2026-10-31 08:13'
updated_date: '2026-11-02 20:35'
labels:
  - 'tier:S'
milestone: m-2
dependencies: []
references:
  - packages/contract/test/fixtures.ts
  - packages/contract/src/index.test.ts
  - packages/contract/src/software.ts
  - packages/engine/src/log/logger.ts
priority: low
type: chore
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the contract's test fixtures show only what the contract has, and a field the contract drops can no longer stay behind in them unnoticed.

Filed from DRAFT-4 (proposed by the worker of DIPO-385). DIPO-355 removed contract versioning: `engine.hello` (packages/contract/src/software.ts, about line 221) takes only `client` and returns `engine`, `daemon`, `offices` and `cursor`. Its fixture in packages/contract/test/fixtures.ts (about lines 636-645) still sends `contract: { major: 1, minor: 0 }` and returns `contract` and `capabilities`. The fixture test in packages/contract/src/index.test.ts parses each fixture with zod objects, which drop unknown keys, so the stale fields pass. The comment above the secret name endings in packages/engine/src/log/logger.ts (about line 30) also still names `engineToken` and `engine_token` as examples, though DIPO-369 removed that token (DRAFT-1, archived, asked for this).

Design: the stale fields go. The fixture test also fails when a fixture holds a key its schema does not know, for command and read args and results and for event data, so the next removed field fails the test; any other stale fixture key this turns up goes in the same change. The logger comment names only current examples. No contract change, so `bun run contract:schema` leaves packages/contract/schema/ as it is. 0005.

```dipo
branch: "DIPO-435/fixtures-no-stale-fields"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(contract) the engine.hello fixture has no contract or capabilities field, and the fixture test fails on a fixture key its schema does not know"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The `engine.hello` fixture has no `contract` or `capabilities` field, shown by the diff
- [ ] #2 The fixture test fails on a fixture key its schema does not know, for commands, reads and events, shown by a test with a planted stale key, and every current fixture passes
- [ ] #3 logger.ts's comment no longer names `engineToken` or `engine_token`, and `bun run contract:schema` leaves no change
<!-- AC:END -->
