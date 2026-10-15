---
id: DIPO-95
title: Mark phase markers as structured output instead of matching text
status: To Do
assignee: []
created_date: '2026-10-15 16:49'
labels:
  - 'tier:S'
milestone: m-0
dependencies:
  - DIPO-83
references:
  - packages/engine/src/run/markers.ts
  - packages/tui/src/output.ts
  - packages/cli/src/watch-command.ts
  - packages/contract/src/
priority: medium
type: feature
ordinal: 85000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: clients tell engine phase markers from worker text by a field in the event, so worker text that looks like a marker is shown as text, and dipo watch renders markers like the TUI does.

Context: DIPO-83 stores markers as plain text lines [dipo] <ISO> phase <name> in the worker output (packages/engine/src/run/markers.ts:27-32) written with no agent. The TUI finds them with a regex over every line (packages/tui/src/output.ts:58-75), so a worker that prints the same shape is drawn as a marker. dipo watch has no marker handling and prints the raw line (packages/cli/src/watch-command.ts).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The work.output event and stored chunk say when a chunk is an engine marker (for example the agent-less chunk flagged as marker with kind and value), as a minor contract addition.
- [ ] #2 The TUI draws a marker only from that flag; a worker line with the marker text is shown as plain text.
- [ ] #3 dipo watch prints markers as a rule line with local time, as the TUI does, and stays plain in non-TTY output.
- [ ] #4 Tests cover a real marker, a worker line that imitates one, and the watch rendering.
<!-- AC:END -->
