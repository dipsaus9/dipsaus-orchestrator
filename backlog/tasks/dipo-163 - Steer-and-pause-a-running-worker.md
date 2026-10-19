---
id: DIPO-163
title: Steer and pause a running worker
status: Ready
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-19 15:14'
labels:
  - 'tier:M'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-138
  - DIPO-142
  - DIPO-145
references:
  - packages/contract/src/office.ts
  - packages/contract/schema/
  - packages/engine/src/run/
  - packages/engine/src/prompts/feedback/
  - packages/cli/src/
  - packages/engine/test/run/
priority: high
type: feature
ordinal: 152000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo steer and dipo pause reach the worker as ADR 0008 section 6 says, a steer to a paused or parked story is sent on resume, a steer to a reviewer is refused, and paused time is left out of the minute cap.

Context: implements ADR 0020 section 9 (steer and pause) on the mechanics of 0008 section 6 and the waiting command path of the 0005 note of 2026-10-17. work.steer and work.pause are provisional and unregistered today (0020 fact 7); work.reassign stays provisional.

```dipo
branch: "DIPO-163/steer-and-pause-workers"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a steer to a running worker is sent next turn wrapped in the steer template"
    - kind: "automated"
      check: "(unit) a steer to a parked story is stored once and sent on resume"
    - kind: "automated"
      check: "(unit) a steer to a reviewer session answers story.notSteerable"
    - kind: "automated"
      check: "(unit) a pause keeps the claim and place, exits after 10 minutes, and the paused time is out of the minute cap"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 work.steer (dipo steer <id> <text>) is stored first as a steer intent and sent as one next-priority user message wrapped in feedback/steer.md, and the reply says delivered next-turn
- [ ] #2 A steer to a paused or parked story is stored once, keyed by its request, and sent with the first message on resume, and the reply says on-resume
- [ ] #3 A steer to a story whose live session is its reviewer, or to a follow-only host, answers story.notSteerable
- [ ] #4 work.pause (dipo pause <id>) stores a pause intent and sends a now-priority message; the run stays In Progress with health paused and keeps its claim, slot and session place; after 10 minutes stdin closes and the process exits, and dipo resume <id> continues it with --resume when allowed
- [ ] #5 Paused time is left out of the minute cap, and a pause that arrives during an engine verify takes effect before the next worker turn
- [ ] #6 work.steer and work.pause are registered with their since on the waiting command path
<!-- AC:END -->
