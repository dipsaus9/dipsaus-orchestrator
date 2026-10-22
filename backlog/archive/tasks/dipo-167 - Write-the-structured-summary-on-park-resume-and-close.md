---
id: DIPO-167
title: 'Write the structured summary on park, resume and close'
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-22 18:16'
labels:
  - 'tier:S'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-155
  - DIPO-166
  - DIPO-164
  - DIPO-150
  - DIPO-284
  - DIPO-290
references:
  - packages/engine/src/run/park.ts
  - packages/engine/src/backlog/fields/
  - packages/engine/src/merge-slot/
  - packages/engine/test/run/
priority: high
type: feature
ordinal: 156000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the task file carries a code-built summary in its implementation notes on park and resume and in its final summary on close, so git holds the highlights of every story's runs.

Context: implements ADR 0020 section 13 (the structured summary on park and close, which 0001 asks for), written with Backlog's native implementation notes and final summary, filled from stored facts.

```dipo
branch: "DIPO-167/structured-summary-on-park-and-close"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a park writes the notes block with each listed field from stored facts"
    - kind: "automated"
      check: "(unit) a resume appends one line and the close-out sets the final summary"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 On park, the task-file commit that writes F16 also appends one implementation-notes block with date, reason and cause, a one-line detail, run id, criteria met of total, loops of cap, review rounds and failed rounds, budget used of limit per cap, last good commit and the number of uncommitted files
- [ ] #2 On resume one line is appended with the date, resumed, the grants and the first line of the note
- [ ] #3 The merge slot's close-out commit sets the final summary with criteria met, loops, review rounds, budget used of limit, runs and resumes, each park in one line, grants, web calls and proposals filed
- [ ] #4 Every value comes from stored facts through the backlog CLI, and no written line is a line of 50 dashes
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-22: combined into DIPO-154 (maintainer, M1 speed-up)
<!-- SECTION:NOTES:END -->
