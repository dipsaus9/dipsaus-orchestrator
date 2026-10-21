---
id: DIPO-254
title: >-
  Report every test-plan entry and deviation, and refuse done while an automated
  entry is open
status: Refined
assignee: []
created_date: '2026-10-20 20:20'
updated_date: '2026-10-21 23:04'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies:
  - DIPO-257
  - DIPO-291
  - DIPO-276
references:
  - packages/engine/src/workers/types.ts
  - packages/engine/src/workers/claude-cli/report-schema.ts
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/src/run/verify-commit.ts
  - packages/engine/src/backlog/fields/block.ts
  - packages/engine/src/prompts/contract/implement.md
  - packages/engine/src/prompts/review.ts
  - packages/engine/src/prompts/feedback.ts
  - packages/engine/src/prompts/feedback/
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/src/retention/policy.ts
  - packages/engine/test/workers/report-schema.test.ts
  - packages/engine/test/run/verify-commit.test.ts
  - packages/engine/test/prompts/
  - packages/engine/test/db/
priority: high
type: feature
ordinal: 136300
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker's done report lists every test-plan entry with a status and evidence and every deviation from the story with its reason; the engine refuses done while an automated entry is not done and tells the worker which, and the reviewer sees both lists.

Context: the maintainer's decision D2 of 2026-10-20 (answer A); dated 0014 section 2 note of 2026-10-20. In the M1 runs 25 of 78 done reports were not quite true and about 10 stories had test-plan items skipped or weakly met (DIPO-227 skipped a daemon test, DIPO-229's "resume first" test passed without the fix; docs/research/2026-10-20-dipo-run-gaps.md sections 3.2 and 3.3). WorkerReport (packages/engine/src/workers/types.ts) has status, criteria, summary, commitSubject, question, notes and needsPermission; its JSON schema is in packages/engine/src/workers/claude-cli/report-schema.ts and it is read in interpret.ts. The test plan is parsed from the story's dipo block (test_plan.entries with kind automated or manual, packages/engine/src/backlog/fields/block.ts). VerifyCommit (packages/engine/src/run/verify-commit.ts) takes a done report, runs verify, checks scope and commits; feedback items are built in packages/engine/src/prompts/feedback.ts with templates in packages/engine/src/prompts/feedback/, and the review task message in packages/engine/src/prompts/review.ts. DIPO-186 adds decisionNotes to the same report; the two are siblings. The desk (DIPO-158) lists deviations once it exists; this story stores them.

```dipo
branch: "DIPO-254/report-test-plan-and-deviations"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) report-schema.test.ts: a report with testPlan (n, status done|not-done|manual, evidence) and deviations (where, what, why) validates; one with an unknown status or a missing evidence fails"
    - kind: "automated"
      check: "(unit) verify-commit.test.ts: a done report with an automated entry not done, or with an entry missing, gets one feedback item naming the entries and no commit; with every automated entry done it commits as before; manual entries never block"
    - kind: "automated"
      check: "(unit) the review task message lists each test-plan status with its evidence and each deviation; the stored rows survive a daemon restart (migration test)"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 WorkerReport gains `testPlan` (one item per test-plan entry: its number, a status of done, not-done or manual, and evidence of at most 500 characters) and `deviations` (where, what differs from a criterion or the context, and why; at most 10 items), in the type and in the report JSON schema with length caps
- [ ] #2 VerifyCommit refuses a done report whose testPlan leaves an automated entry of the story's test plan not done or missing: it commits nothing and sends one feedback item that names each such entry, and the run goes on; manual entries never block, and a story with no test plan is unchanged
- [ ] #3 The testPlan statuses and the deviations of each done report are stored for the run in a table with a registered migration and a TABLE_RETENTION line, and the review task message lists each status with its evidence and each deviation
- [ ] #4 The worker contract in packages/engine/src/prompts/contract/implement.md asks for the two fields with tool-neutral wording, and its golden is updated
- [ ] #5 Tests cover the schema, the refusal and its feedback, the manual and no-plan cases, the stored rows and the review task message
<!-- AC:END -->
