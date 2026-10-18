---
id: DIPO-203
title: Point the sendAsIntent doc at the file that sends the report-ended closeStdin
status: Refined
assignee: []
created_date: '2026-10-18 08:55'
updated_date: '2026-10-18 08:55'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/run/intents.ts
priority: low
type: chore
ordinal: 192000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the sendAsIntent doc comment names the file that really sends the closeStdin after a report that ended the run.

Context: review of the DIPO-126 ADR note (PR #195). The exceptions list in the sendAsIntent doc (packages/engine/src/run/intents.ts) says the report-ended closeStdin is in `run/control.ts`; on main it is sent in run/control-turns.ts (the `ended` case), after DIPO-128 split the run code.

```dipo
branch: "DIPO-203/intents-doc-pointer"
unknowns: []
test_plan:
  not_applicable: "a comment-only change; bun run verify covers formatting and lint"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The sendAsIntent doc comment in packages/engine/src/run/intents.ts names run/control-turns.ts for the report-ended closeStdin, and every other file it names still holds what it says; bun run verify passes
<!-- AC:END -->
