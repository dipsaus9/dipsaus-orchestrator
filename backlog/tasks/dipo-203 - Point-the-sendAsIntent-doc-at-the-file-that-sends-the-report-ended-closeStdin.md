---
id: DIPO-203
title: Point the sendAsIntent doc at the file that sends the report-ended closeStdin
status: Done
assignee: []
created_date: '2026-10-18 08:55'
updated_date: '2026-10-19 07:02'
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
Outcome: the intents.ts doc comments name the files that really hold what they describe: the report-ended closeStdin, the record-only intent sites and RunSteering.

Context: review of the DIPO-126 ADR note (PR #195). The exceptions list in the sendAsIntent doc (packages/engine/src/run/intents.ts) says the report-ended closeStdin is in `run/control.ts`; on main it is sent in run/control-turns.ts (the `ended` case), after DIPO-128 split the run code. The same header says the record-only sites are "all in run/outcomes.ts"; they are now in run/outcome-exits.ts, run/outcome-sessions.ts and run/resumption.ts, and outcomes.ts holds little more than its file comment. It also says RunSteering is in control.ts, which only re-exports it from run/control-types.ts.

```dipo
branch: "DIPO-203/intents-doc-pointer"
unknowns: []
test_plan:
  not_applicable: "a comment-only change; bun run verify covers formatting and lint"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The sendAsIntent doc comment in packages/engine/src/run/intents.ts names run/control-turns.ts for the report-ended closeStdin, and every other file it names still holds what it says; bun run verify passes
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M59F1QT8H8W8RDNGS8TN9PZA (Haiku low, 12 turns, about $0.01, 2 min) reported done, In Review, with no denied call. The intents.ts doc comments now name run/control-turns.ts (report-ended closeStdin), run/control-types.ts (RunSteering), outcome-exits.ts (plan-limit pause, report-feedback steer), outcome-sessions.ts (start-failed stop) and resumption.ts (park-resume answer); the review checked each against the code, including the report-feedback path the worker was unsure of. Fixed on top: one comment line rewrapped within 100 columns. Verify outside the sandbox: 3425 pass, 2 skip, 0 fail. Review passed.
<!-- SECTION:NOTES:END -->
