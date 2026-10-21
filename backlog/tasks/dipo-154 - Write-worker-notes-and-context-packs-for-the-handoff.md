---
id: DIPO-154
title: Write worker notes and context packs for the handoff
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-21 20:24'
labels:
  - 'tier:S'
  - 'slice:m1a'
  - needs-refinement
milestone: m-1
dependencies:
  - DIPO-138
  - DIPO-148
  - DIPO-284
  - DIPO-289
references:
  - packages/engine/src/run/
  - packages/engine/src/prompts/
  - packages/engine/src/context/pack.ts
  - packages/engine/test/run/
  - packages/engine/test/prompts/
priority: high
type: feature
ordinal: 143000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: every turn's notes and every session's context pack are stored, and a handoff carries the newest notes and the run's open feedback, so a new session after a park starts from where the last one stopped.

Context: implements ADR 0020 section 6 (the handoff a new session gets). Today recordWorkerNotes (prompts/notes.ts) and recordContextPack (context/pack.ts) have no production caller and RunResumer passes openFeedback: [] (0020 fact 6).

```dipo
branch: "DIPO-154/store-worker-notes-and-context-packs"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) notes from a turn report are stored and replaced per agent, and kept across a park"
    - kind: "automated"
      check: "(unit) the handoff lists open feedback items from feedback_items and leaves out items answered by a later green verify"
    - kind: "automated"
      check: "(unit) a task message build records a context pack with the head SHA and blob ids"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Run control stores the notes of every turn report with recordWorkerNotes (at most 1,500 characters), keyed by worktree and agent and replacing that agent's earlier notes; a park keeps them and teardown deletes them
- [ ] #2 The launcher and the resumer call recordContextPack whenever they build a task message, with the head SHA and the blob ids of the scope and input files
- [ ] #3 A handoff's feedback lists the run's feedback items not yet answered by a later green verify or approval, read with their text from feedback_items, plus the resume note
- [ ] #4 A test parks a run mid-turn after an earlier turn reported notes and shows the handoff carries those notes
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: with the box kept until merge, handoff notes matter less (0021 section 6).
<!-- SECTION:NOTES:END -->
