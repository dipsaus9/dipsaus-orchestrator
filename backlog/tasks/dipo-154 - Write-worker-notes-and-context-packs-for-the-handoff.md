---
id: DIPO-154
title: >-
  Write handoff notes, context packs and the structured summary on park, resume
  and close
status: Done
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-23 06:25'
labels:
  - 'tier:S'
  - 'slice:m1a'
  - needs-refinement
milestone: m-1
dependencies:
  - DIPO-138
  - DIPO-148
  - DIPO-284
  - DIPO-290
  - DIPO-149
  - DIPO-292
  - DIPO-293
  - DIPO-294
  - DIPO-299
  - DIPO-152
  - DIPO-164
  - DIPO-150
references:
  - '- packages/engine/src/backlog/fields/'
  - packages/engine/src/backlog/fields/index.ts
  - packages/engine/src/backlog/fields/summary.ts
  - packages/engine/src/context/pack.ts
  - packages/engine/src/merge-slot/
  - packages/engine/src/merge-slot/close-out.ts
  - packages/engine/src/merge-slot/index.ts
  - packages/engine/src/prompts/
  - packages/engine/src/prompts/handoff.ts
  - packages/engine/src/prompts/index.ts
  - packages/engine/src/run/
  - packages/engine/src/run/control.ts
  - packages/engine/src/run/index.ts
  - packages/engine/src/run/launch.ts
  - packages/engine/src/run/open-feedback.ts
  - packages/engine/src/run/park.ts
  - packages/engine/src/run/prompts.ts
  - packages/engine/src/run/resume.ts
  - packages/engine/src/run/resumption.ts
  - packages/engine/src/run/summary.ts
  - packages/engine/src/run/work-run.ts
  - packages/engine/test/prompts/
  - packages/engine/test/prompts/store.test.ts
  - packages/engine/test/run/
  - packages/engine/test/run/control.test.ts
  - packages/engine/test/run/park-commit.test.ts
  - packages/engine/test/run/reattach.test.ts
  - packages/engine/test/run/start.test.ts
  - packages/engine/test/run/summary.test.ts
priority: high
type: feature
ordinal: 143000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: every turn's notes and every session's context pack are stored, a handoff carries the newest notes and the run's open feedback, and the task file carries a code-built summary in its implementation notes on park and resume and in its final summary on close, so a new session starts where the last one stopped and git holds the highlights of every story's runs.

Context: implements ADR 0020 section 6 (the handoff a new session gets). Today recordWorkerNotes (prompts/notes.ts) and recordContextPack (context/pack.ts) have no production caller and RunResumer passes openFeedback: [] (0020 fact 6).

From DIPO-167: implements ADR 0020 section 13 (the structured summary on park and close, which 0001 asks for), written with Backlog's native implementation notes and final summary, filled from stored facts.

```dipo
branch: "DIPO-154/handoff-and-summary"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) notes from a turn report are stored and replaced per agent, and kept across a park"
    - kind: "automated"
      check: "(unit) the handoff lists open feedback items from feedback_items and leaves out items answered by a later green verify"
    - kind: "automated"
      check: "(unit) a task message build records a context pack with the head SHA and blob ids"
    - kind: "automated"
      check: "(unit) a park writes the notes block with each listed field from stored facts"
    - kind: "automated"
      check: "(unit) a resume appends one line and the close-out sets the final summary"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Run control stores the notes of every turn report with recordWorkerNotes (at most 1,500 characters), keyed by worktree and agent and replacing that agent's earlier notes; a park keeps them and teardown deletes them
- [x] #2 The launcher and the resumer call recordContextPack whenever they build a task message, with the head SHA and the blob ids of the scope and input files
- [x] #3 A handoff's feedback lists the run's feedback items not yet answered by a later green verify or approval, read with their text from feedback_items, plus the resume note
- [x] #4 A test parks a run mid-turn after an earlier turn reported notes and shows the handoff carries those notes
- [x] #5 (from DIPO-167) On park, the task-file commit that writes F16 also appends one implementation-notes block with date, reason and cause, a one-line detail, run id, criteria met of total, loops of cap, review rounds and failed rounds, budget used of limit per cap, last good commit and the number of uncommitted files
- [x] #6 (from DIPO-167) On resume one line is appended with the date, resumed, the grants and the first line of the note
- [x] #7 (from DIPO-167) Every value comes from stored facts through the backlog CLI, and no written line is a line of 50 dashes
- [x] #8 The final summary (criteria met, loops, review rounds, budget used of limit, runs and resumes, each park in one line, grants, web calls and proposals filed) is built from stored facts and written through the Backlog CLI by writeCloseOutSummary (packages/engine/src/merge-slot/close-out.ts); the merge slot calling it in its close-out commit is DIPO-150
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: with the box kept until merge, handoff notes matter less (0021 section 6).

2026-10-22: combined from DIPO-167 (maintainer, M1 speed-up)

2026-10-22: dropped the dependencies on DIPO-159 (which now holds DIPO-289), DIPO-155 (a dependency of DIPO-167) and DIPO-166 (a dependency of DIPO-167) to break a dependency cycle left by the M1 combine; those stories now come after this one.

2026-10-22: the merge-slot call of criterion 7 moved to DIPO-150 (the close-out commit does not exist yet); this story delivers the builder and writer.

2026-10-22: built outside dipo, reviewed (one block: the close-out call, moved to DIPO-150; correctness advisories fixed: a failed summary never costs the park or lift, feedback answered per source, the resume note capped). Green CI heads are not stored yet, so a box run's CI item stays listed in the handoff until a verdict approves (follow-up).
<!-- SECTION:NOTES:END -->
