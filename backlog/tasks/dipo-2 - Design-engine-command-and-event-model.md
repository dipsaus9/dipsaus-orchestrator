---
id: DIPO-2
title: Design engine command and event model
status: To Do
assignee: []
created_date: '2026-10-09 19:17'
updated_date: '2026-10-10 10:16'
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
Outcome: an ADR defining the engine's public boundary. Commands are the single entry point for every client (CLI, TUI, conversation layer, future web or desktop UI); the conversation layer may only issue existing commands, with confirmation. Commands include at least: office open and switch, rescan, run, approve, reject, answer, steer, pause, resume, reassign, stop, drop, and test pass or fail with a note. Events include at least: state changed, worker output, gate reached, parked, and usage updates. Events must carry enough to show who (agent, role) works on what story, in which phase, with what progress and usage. The contract must be versioned and transport-independent. Include how a client attaches mid-run and catches up on missed events.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 ADR docs/decisions/0005-command-and-event-model.md lists commands, events and their payload shapes
- [ ] #2 ADR defines versioning and how a late-attaching client catches up
- [ ] #3 ADR confirms no client needs engine internals
- [ ] #4 Maintainer approved the decision
- [ ] #5 ADR lists every command above with its payload, including intervention commands (answer, steer, pause, resume, reassign, stop) and test pass or fail
- [ ] #6 ADR shows events carry agent, role, story, phase, progress and usage for the manager overview
- [ ] #7 Facts in, status derived: events come from a change log of stored facts, and a reconnecting client replays missed events (research idea 1)
- [ ] #8 Clients discover engine capabilities through a small read surface and capability flags (research idea 10)
- [ ] #9 Event stream sends debounced deltas, not full state (research idea 21)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Scope addition (decision 0011): commands are the single entry point for every client: CLI, conversation layer, TUI and future web or desktop UI. The conversation layer may only issue existing commands, with confirmation.

Scope addition (decision 0011 item 10): commands for intervening in running work (answer, steer, pause, resume, reassign, stop). Events must carry enough to show who works on what, phase, progress and usage.
<!-- SECTION:NOTES:END -->
