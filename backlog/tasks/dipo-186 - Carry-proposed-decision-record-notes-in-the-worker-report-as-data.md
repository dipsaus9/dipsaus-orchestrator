---
id: DIPO-186
title: Carry proposed decision-record notes in the worker report as data
status: Refined
assignee: []
created_date: '2026-10-17 20:30'
updated_date: '2026-10-17 20:30'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies:
  - DIPO-166
references:
  - packages/engine/src/workers/claude-cli/report-schema.ts
  - packages/engine/src/workers/types.ts
  - packages/engine/src/prompts/contract/implement.md
  - packages/engine/src/run/
  - packages/engine/test/workers/
  - packages/engine/test/prompts/
  - packages/engine/test/run/
priority: medium
type: enhancement
ordinal: 175000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker that proposes a note for a decision record puts the decision file, the section and the text in its report, so dipo can check that the file and section exist and show the note to the maintainer, and a done report no longer claims a note that is in no field.

Context: the second M1a run, DIPO-126 (run_01M55EM75CBSWYH0TE2QQPAD7N). The worker's done report said in its notes "The 0008 note above is proposed only", but no note was in the diff, the task file or the report. dipo's done gate cannot see that: the report has only free text for this (summary and notes in WorkerReportSchema, packages/engine/src/workers/claude-cli/report-schema.ts, and WorkerReport, packages/engine/src/workers/types.ts; the report is not in packages/contract). Workers do not change docs/decisions/ without the maintainer's approval (CLAUDE.md), so a proposed note has to travel as data. DIPO-166 adds report proposals (kind follow-up or spike) stored and shown on the desk, the nearest place for it, so this story depends on it.

The report shape is listed in 0008 section 1, 0014 section 2 and 0020 section 11. A new field or a new proposal kind changes that shape, so it needs an ADR amendment the maintainer approves. The maintainer writes that amendment line; this story does not edit docs/decisions/. It stays open until the unknown below is answered.

```dipo
branch: "DIPO-186/decision-notes-in-report"
unknowns:
  - q: "Where does a proposed decision-record note go in the worker report: a new optional field decisionNotes (decision file, section, text; at most 3), or a third DIPO-166 proposals kind decision-note? Either changes the WorkerReport shape that 0008 section 1, 0014 section 2 and 0020 section 11 list, so which one, and do you approve the amendment?"
    status: "open"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the report schema accepts a decision note with file, section and text, and refuses one with a missing part, over its length cap, or a fourth note"
    - kind: "automated"
      check: "(unit) a done report whose note names a missing decision file, or a section heading not in it, gets one feedback turn naming the file and the section"
    - kind: "automated"
      check: "(unit) a checked note is stored with its story and run and listed on the desk"
    - kind: "automated"
      check: "(golden) the rendered system file holds the decision-note rule"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 WorkerReportSchema (packages/engine/src/workers/claude-cli/report-schema.ts) and WorkerReport (packages/engine/src/workers/types.ts) carry a proposed decision note in the shape the maintainer chose: the decision file path under docs/decisions/, the section heading and the note text, each with a length cap, at most 3 per report, and WORKER_REPORT_JSON_SCHEMA includes it
- [ ] #2 When a report carries a decision note, code checks that the file exists in the story worktree and that the section heading is in it; a miss gets one feedback turn naming the file and the section, and the rest of the report is handled as before
- [ ] #3 Each checked note is stored with its story and run and shown on the desk next to the DIPO-166 proposals, with the file, the section and the text
- [ ] #4 L1 (packages/engine/src/prompts/contract/implement.md) says a note proposed for a decision record goes in that report field, is never written under docs/decisions/, and is never only described in summary or notes; packages/engine/test/prompts/golden/system-implement-developer.md is updated and its test passes
<!-- AC:END -->
