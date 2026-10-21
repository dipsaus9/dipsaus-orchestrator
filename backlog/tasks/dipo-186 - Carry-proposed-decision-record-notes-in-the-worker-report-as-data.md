---
id: DIPO-186
title: Carry proposed decision-record notes in the worker report as data
status: Refined
assignee: []
created_date: '2026-10-17 20:30'
updated_date: '2026-10-21 20:24'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies:
  - DIPO-166
  - DIPO-284
  - DIPO-289
references:
  - packages/engine/src/workers/claude-cli/report-schema.ts
  - packages/engine/src/workers/types.ts
  - packages/engine/src/prompts/contract/implement.md
  - packages/engine/src/run/
  - packages/engine/test/workers/
  - packages/engine/test/prompts/
  - packages/engine/test/run/
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/src/retention/policy.ts
  - packages/engine/test/db/
  - packages/engine/src/views/
  - packages/engine/src/reads/
  - packages/engine/test/views/
  - packages/cli/src/
priority: medium
type: enhancement
ordinal: 175000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker that proposes a note for a decision record puts the decision file, the section and the text in its report, so dipo can check that the file and section exist and show the note to the maintainer, and a done report no longer claims a note that is in no field.

Context: the second M1a run, DIPO-126 (run_01M55EM75CBSWYH0TE2QQPAD7N). The worker's done report said in its notes "The 0008 note above is proposed only", but no note was in the diff, the task file or the report. dipo's done gate cannot see that: the report has only free text for this (summary and notes in WorkerReportSchema, packages/engine/src/workers/claude-cli/report-schema.ts, and WorkerReport, packages/engine/src/workers/types.ts; the report is not in packages/contract). Workers do not change docs/decisions/ without the maintainer's approval (CLAUDE.md), so a proposed note has to travel as data. DIPO-166 adds report proposals (kind follow-up or spike) stored and shown on the desk, the nearest place for it, so this story depends on it. DIPO-166 stores proposals in its proposals table, and DIPO-158 (a dependency of DIPO-166) adds the office.desk read with its DeskItem list in packages/engine/src/views/ and packages/engine/src/reads/, and dipo desk in packages/cli/src/.

The report shape is listed in 0008 section 1, 0014 section 2 and 0020 section 11; their notes of 2026-10-20 (DIPO-186) add the optional field decisionNotes, carried as data, shown to the maintainer and never written to docs/decisions/ by dipo. The notes are stored in a table of their own, not as a DIPO-166 proposals kind. This story does not edit docs/decisions/. L1 holds no digit and no path (packages/engine/test/prompts/system.test.ts), so its rule names neither the cap nor the directory.

```dipo
branch: "DIPO-186/decision-notes-in-report"
unknowns:
  - q: "Where does a proposed decision-record note go in the worker report: a new optional field decisionNotes (decision file, section, text; at most 3), or a third DIPO-166 proposals kind decision-note? Either changes the WorkerReport shape that 0008 section 1, 0014 section 2 and 0020 section 11 list, so which one, and do you approve the amendment?"
    status: "resolved"
    answer: "A (maintainer, 2026-10-20): a new optional WorkerReport field decisionNotes, at most 3 entries of decision file, section and text; the notes of 2026-10-20 in 0008 section 1, 0014 section 2 and 0020 section 11 approve it, carried as data and shown to the maintainer, never written to docs/decisions/ by dipo."
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the report schema accepts a decision note with file, section and text, and refuses one with a missing part, over its length cap, or a fourth note"
    - kind: "automated"
      check: "(unit) a done report whose note names a missing decision file, or a section heading not in it, gets one feedback turn naming the file and the section"
    - kind: "automated"
      check: "(unit) a checked note is stored in decision_notes with its story and run and listed on the desk; a fresh and a migrated database match"
    - kind: "automated"
      check: "(golden) the rendered system file holds the decision-note rule, and system.test.ts still finds no digit and no path in it"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 WorkerReportSchema (packages/engine/src/workers/claude-cli/report-schema.ts) and WorkerReport (packages/engine/src/workers/types.ts) carry an optional field decisionNotes: at most 3 entries, each the decision file path under docs/decisions/, the section heading and the note text, each with a length cap; WORKER_REPORT_JSON_SCHEMA includes it and a report without it parses as before
- [ ] #2 When a report carries a decision note, code checks that the file exists in the story worktree and that the section heading is in it; a miss gets one feedback turn naming the file and the section, and the rest of the report is handled as before
- [ ] #3 Each checked note is stored with its story key and run id in a new decision_notes table (file, section, text, story key, run, state, times) added by a migration in packages/engine/src/db/migrations/, registered in packages/engine/src/db/schema.ts and given a retention tier in packages/engine/src/retention/policy.ts; a test in packages/engine/test/db/ shows a fresh and a migrated database match
- [ ] #4 The office.desk read (DIPO-158) returns each open decision note as a DeskItem in the proposals group, with the file, the section and the text in its detail, and dipo desk prints it; a test in packages/engine/test/views/ lists a stored note on the desk
- [ ] #5 L1 (packages/engine/src/prompts/contract/implement.md) says a note proposed for a decision record goes in the decisionNotes field of the report, is never written into the decision records, and is never only described in summary or notes, in words with no digit and no path; packages/engine/test/prompts/golden/system-implement-developer.md is updated and packages/engine/test/prompts/system.test.ts passes
<!-- AC:END -->
