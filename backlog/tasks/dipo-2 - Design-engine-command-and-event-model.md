---
id: DIPO-2
title: Design engine command and event model
status: To Do
assignee: []
created_date: '2026-10-09 19:17'
updated_date: '2026-10-09 19:33'
labels:
  - architecture
milestone: m-0
dependencies:
  - DIPO-1
priority: high
type: spike
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an ADR defining the engine's public boundary: the commands clients send (approve, reject, pause, steer, resume, drop) and the events clients receive (state changed, worker output, gate reached, parked). This is the contract every UI uses, so it must be versioned and transport-independent. Include how a client attaches mid-run and catches up on missed events.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 ADR docs/decisions/0005-command-and-event-model.md lists commands, events and their payload shapes
- [ ] #2 ADR defines versioning and how a late-attaching client catches up
- [ ] #3 ADR confirms no client needs engine internals
- [ ] #4 Maintainer approved the decision
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Scope addition (decision 0011): commands are the single entry point for every client: CLI, conversation layer, TUI and future web or desktop UI. The conversation layer may only issue existing commands, with confirmation.
<!-- SECTION:NOTES:END -->
