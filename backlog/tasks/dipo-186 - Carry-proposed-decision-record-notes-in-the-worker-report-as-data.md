---
id: DIPO-186
title: >-
  Carry the worker's report as data: test-plan entries, deviations, proposals
  and decision notes
status: Refined
assignee: []
created_date: '2026-10-17 20:30'
updated_date: '2026-10-22 18:15'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies:
  - DIPO-284
  - DIPO-290
  - DIPO-292
  - DIPO-293
  - DIPO-294
  - DIPO-152
  - DIPO-240
  - DIPO-276
  - DIPO-296
  - DIPO-299
references:
  - packages/cli/src/
  - packages/engine/src/backlog/fields/block.ts
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/src/prompts/contract/implement.md
  - packages/engine/src/prompts/feedback.ts
  - packages/engine/src/prompts/feedback/
  - packages/engine/src/prompts/review.ts
  - packages/engine/src/reads/
  - packages/engine/src/retention/policy.ts
  - packages/engine/src/run/
  - packages/engine/src/run/control.ts
  - packages/engine/src/run/verify-commit.ts
  - packages/engine/src/views/
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/src/workers/claude-cli/report-schema.ts
  - packages/engine/src/workers/types.ts
  - packages/engine/test/db/
  - packages/engine/test/prompts/
  - packages/engine/test/run/
  - packages/engine/test/run/control.test.ts
  - packages/engine/test/run/verify-commit.test.ts
  - packages/engine/test/views/
  - packages/engine/test/workers/
  - packages/engine/test/workers/report-schema.test.ts
priority: high
type: enhancement
ordinal: 175000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker's done report lists every test-plan entry with a status and evidence, every deviation with its reason, up to three follow-up or spike proposals and any note proposed for a decision record (file, section and text), all as data; the engine refuses done while an automated entry is not done, stores the proposals and the checked notes without changing the story, shows the notes to the maintainer and both lists to the reviewer, and sends a box worker's report that shows no verify run after its last edit back once.

Context: the second M1a run, DIPO-126 (run_01M55EM75CBSWYH0TE2QQPAD7N). The worker's done report said in its notes "The 0008 note above is proposed only", but no note was in the diff, the task file or the report. dipo's done gate cannot see that: the report has only free text for this (summary and notes in WorkerReportSchema, packages/engine/src/workers/claude-cli/report-schema.ts, and WorkerReport, packages/engine/src/workers/types.ts; the report is not in packages/contract). Workers do not change docs/decisions/ without the maintainer's approval (CLAUDE.md), so a proposed note has to travel as data. DIPO-166 adds report proposals (kind follow-up or spike) stored and shown on the desk, the nearest place for it, so this story depends on it. DIPO-166 stores proposals in its proposals table, and DIPO-158 (a dependency of DIPO-166) adds the office.desk read with its DeskItem list in packages/engine/src/views/ and packages/engine/src/reads/, and dipo desk in packages/cli/src/.

The report shape is listed in 0008 section 1, 0014 section 2 and 0020 section 11; their notes of 2026-10-20 (DIPO-186) add the optional field decisionNotes, carried as data, shown to the maintainer and never written to docs/decisions/ by dipo. The notes are stored in a table of their own, not as a DIPO-166 proposals kind. This story does not edit docs/decisions/. L1 holds no digit and no path (packages/engine/test/prompts/system.test.ts), so its rule names neither the cap nor the directory.

From DIPO-254: the maintainer's decision D2 of 2026-10-20 (answer A); dated 0014 section 2 note of 2026-10-20. In the M1 runs 25 of 78 done reports were not quite true and about 10 stories had test-plan items skipped or weakly met (DIPO-227 skipped a daemon test, DIPO-229's "resume first" test passed without the fix; docs/research/2026-10-20-dipo-run-gaps.md sections 3.2 and 3.3). WorkerReport (packages/engine/src/workers/types.ts) has status, criteria, summary, commitSubject, question, notes and needsPermission; its JSON schema is in packages/engine/src/workers/claude-cli/report-schema.ts and it is read in interpret.ts. The test plan is parsed from the story's dipo block (test_plan.entries with kind automated or manual, packages/engine/src/backlog/fields/block.ts). VerifyCommit (packages/engine/src/run/verify-commit.ts) takes a done report, runs verify, checks scope and commits; feedback items are built in packages/engine/src/prompts/feedback.ts with templates in packages/engine/src/prompts/feedback/, and the review task message in packages/engine/src/prompts/review.ts. DIPO-186 adds decisionNotes to the same report; the two are siblings. The desk (DIPO-158) lists deviations once it exists; this story stores them.

From DIPO-259: the maintainer's decision D6 of 2026-10-20 (answer A): DIPO-166 is split. This story is the first part (166a): the report field and the proposals table. DIPO-166 keeps the rest: the desk listing (after DIPO-158), proposal.accept and proposal.dismiss with their events, the Backlog draft through the lane and the CLI (0020 section 11c, sections 14 and 15). In the M1 runs follow-ups were written into notes that nothing acts on (docs/research/2026-10-20-dipo-run-gaps.md section 5, item 9). WorkerReport is in packages/engine/src/workers/types.ts and its schema in packages/engine/src/workers/claude-cli/report-schema.ts; a done report is handled in packages/engine/src/run/verify-commit.ts and a blocked one in packages/engine/src/run/control.ts; migrations are registered in packages/engine/src/db/schema.ts with a retention tier in packages/engine/src/retention/policy.ts (the newest migration on main is 0040).

```dipo
branch: "DIPO-186/worker-report-data"
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
    - kind: "automated"
      check: "(unit) report-schema.test.ts: a report with testPlan (n, status done|not-done|manual, evidence) and deviations (where, what, why) validates; one with an unknown status or a missing evidence fails"
    - kind: "automated"
      check: "(unit) verify-commit.test.ts: a done report with an automated entry not done, or with an entry missing, gets one feedback item naming the entries and no commit; with every automated entry done it commits as before; manual entries never block"
    - kind: "automated"
      check: "(unit) the review task message lists each test-plan status with its evidence and each deviation; the stored rows survive a daemon restart (migration test)"
    - kind: "automated"
      check: "(unit) report-schema.test.ts: a report with three proposals validates and one with four fails; title, outcome and why have length caps"
    - kind: "automated"
      check: "(unit) proposals of a done and of a blocked report are stored; a repeat with the same title and paths is deduped; the story's status and the run's end are unchanged"
    - kind: "automated"
      check: "(migration) proposals exists with retention tier S"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 WorkerReportSchema (packages/engine/src/workers/claude-cli/report-schema.ts) and WorkerReport (packages/engine/src/workers/types.ts) carry an optional field decisionNotes: at most 3 entries, each the decision file path under docs/decisions/, the section heading and the note text, each with a length cap; WORKER_REPORT_JSON_SCHEMA includes it and a report without it parses as before
- [ ] #2 When a report carries a decision note, code checks that the file exists in the story worktree and that the section heading is in it; a miss gets one feedback turn naming the file and the section, and the rest of the report is handled as before
- [ ] #3 Each checked note is stored with its story key and run id in a new decision_notes table (file, section, text, story key, run, state, times) added by a migration in packages/engine/src/db/migrations/, registered in packages/engine/src/db/schema.ts and given a retention tier in packages/engine/src/retention/policy.ts; a test in packages/engine/test/db/ shows a fresh and a migrated database match
- [ ] #4 The office.desk read (DIPO-158) returns each open decision note as a DeskItem in the proposals group, with the file, the section and the text in its detail, and dipo desk prints it; a test in packages/engine/test/views/ lists a stored note on the desk
- [ ] #5 L1 (packages/engine/src/prompts/contract/implement.md) says a note proposed for a decision record goes in the decisionNotes field of the report, is never written into the decision records, and is never only described in summary or notes, in words with no digit and no path; packages/engine/test/prompts/golden/system-implement-developer.md is updated and packages/engine/test/prompts/system.test.ts passes
- [ ] #6 (from DIPO-254) WorkerReport gains `testPlan` (one item per test-plan entry: its number, a status of done, not-done or manual, and evidence of at most 500 characters) and `deviations` (where, what differs from a criterion or the context, and why; at most 10 items), in the type and in the report JSON schema with length caps
- [ ] #7 (from DIPO-254) VerifyCommit refuses a done report whose testPlan leaves an automated entry of the story's test plan not done or missing: it commits nothing and sends one feedback item that names each such entry, and the run goes on; manual entries never block, and a story with no test plan is unchanged
- [ ] #8 (from DIPO-254) The testPlan statuses and the deviations of each done report are stored for the run in a table with a registered migration and a TABLE_RETENTION line, and the review task message lists each status with its evidence and each deviation
- [ ] #9 (from DIPO-254) The worker contract in packages/engine/src/prompts/contract/implement.md asks for the two fields with tool-neutral wording, and its golden is updated
- [ ] #10 (from DIPO-254) Tests cover the schema, the refusal and its feedback, the manual and no-plan cases, the stored rows and the review task message
- [ ] #11 (from DIPO-259) WorkerReport gains `proposals` (kind follow-up or spike, title, outcome, why, optional paths; at most 3) in done and blocked reports, in the type and the report JSON schema with length caps
- [ ] #12 (from DIPO-259) A proposals table (office, story key, run, kind, title, outcome, why, paths, hash, state open, times; retention tier S) has a migration registered in packages/engine/src/db/schema.ts and a TABLE_RETENTION line, and stores each proposal of a report, deduplicated by a hash of its title and paths
- [ ] #13 (from DIPO-259) Storing proposals changes nothing about the story's status, the run's end or the commit
- [ ] #14 (from DIPO-259) The worker contract in packages/engine/src/prompts/contract/implement.md says, with tool-neutral wording, to put follow-ups and spike ideas in proposals instead of notes or extra work, and its golden is updated
- [ ] #15 (from DIPO-259) Tests cover the schema caps, storing from a done and a blocked report, the dedupe and the migration
- [ ] #16 A box worker's done report that shows no run of the office's verify (or test) command after its last edit is sent back once to the worker to run it and report failures that only the missing git causes (gap of the DIPO-301 box run, 2026-10-22)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-22: combined from DIPO-254, DIPO-259 (maintainer, M1 speed-up)

2026-10-22: dropped the dependencies on DIPO-166, DIPO-159 (which now holds DIPO-289), DIPO-149 (which now holds DIPO-291) and DIPO-256 (a dependency of DIPO-259) to break a dependency cycle left by the M1 combine; those stories now come after this one.
<!-- SECTION:NOTES:END -->
