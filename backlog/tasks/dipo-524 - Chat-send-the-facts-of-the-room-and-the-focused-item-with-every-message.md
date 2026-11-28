---
id: DIPO-524
title: 'Chat: send the facts of the room and the focused item with every message'
status: Refined
assignee: []
created_date: '2026-11-28 14:11'
labels:
  - 'tier:M'
  - 'role:developer'
milestone: m-5
dependencies:
  - DIPO-523
references:
  - packages/engine/src/run/planning.ts
  - packages/engine/src/prompts/task/planning-roles.md
  - packages/contract/src/work.ts
  - docs/design/chat-and-activity/spec.md
priority: high
type: feature
ordinal: 485000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want dipo to know what I am looking at when I ask, so that it helps me decide on the Desk, get stories Ready in the Queue, fix a run and talk process in Retro without me explaining.

P3. The context `{ room, item? }` is stored with each message. Code (never a model) builds the facts per place, as 0022 does per kind today: Desk item and list; Queue story, gate, chain, Ready and waiting lists, files of running stories; Run phase, health, criteria, the last 200 stream lines, verify and CI output, last findings, budget; reader story, criteria, rounds, runs; Retro the numbers of the period on screen; Roles what the roles kind gets; Background the item and its log tail. Facts go once per change of context. The proposal schemas follow the context (role proposals only in Roles). `/general` sends no item, `/here` adds it back.

Design: docs/design/chat-and-activity/ (spec.md, P3 and The chat (context divider, context line)). The mocks win; a cell difference is a bug (DIPO-520).

```dipo
branch: "DIPO-524/chat-context"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a message from the Queue on a Refined story carries its gate result and chain"
    - kind: "automated"
      check: "(unit) a second message from the same place adds no facts"
    - kind: "automated"
      check: "(unit) a role proposal outside the Roles context is refused with the context named"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 chat.message carries and stores a context of room and optional item
- [ ] #2 Code builds the facts for each room spec.md lists and sends them when the context changes
- [ ] #3 The proposal schemas follow the context
- [ ] #4 /general and /here drop and restore the item
<!-- AC:END -->
