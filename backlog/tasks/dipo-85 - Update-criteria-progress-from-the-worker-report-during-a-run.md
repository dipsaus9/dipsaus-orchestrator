---
id: DIPO-85
title: Update criteria progress from the worker report during a run
status: Done
assignee: []
created_date: '2026-10-15 16:49'
updated_date: '2026-10-16 07:20'
labels:
  - 'tier:S'
milestone: m-0
dependencies: []
references:
  - packages/engine/src/views/work.ts
  - packages/engine/src/run/verify-commit.ts
  - packages/engine/src/run/work-run.ts
  - packages/engine/src/run/records.ts
  - packages/engine/src/run/criteria.ts
  - packages/engine/src/ingest/ingestor.ts
  - packages/engine/src/db/schema.ts
  - packages/engine/src/db/migrations/0024-run-criteria.ts
  - packages/engine/test/views/helpers.ts
  - packages/engine/test/run/criteria-progress.test.ts
  - packages/engine/test/run/work-run.test.ts
  - packages/engine/src/stories/read.ts
  - packages/engine/src/stories/apply.ts
priority: high
type: feature
ordinal: 75000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: while a run is live, progress.criteriaMet counts the acceptance criteria the worker report marks met (and the branch tip checks off), so the TUI boxes, dipo watch and the overview show real progress instead of 0/N until the story merges.

Context: seen in the M0 delivery sessions of 2026-10-14/15: every run showed criteria 0/N and the detail drew [ ][ ] up to In Review. The run view reads criteria from backlog_mirror (packages/engine/src/views/work.ts:99-118, select criteria_met from backlog_mirror), which is the base-branch index (packages/engine/src/stories/apply.ts:367), so checks on the story branch never reach it before merge. The run start fixes the count from the base view (packages/engine/src/run/work-run.ts:494-496). The worker report criteria are only used to check off ACs at commit time (packages/engine/src/run/verify-commit.ts:615-624) and are not stored as progress; work.progress entries reuse runProgress (packages/engine/src/run/verify-commit.ts:718-740).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The run progress criteriaMet is the number of known criteria the latest accepted worker report marks met (or the criteria checked on the story branch tip), stored as a run fact so a daemon restart keeps it; criteriaTotal stays the story total.
- [x] #2 A work.progress event carries the new count when a report changes it, and the TUI detail boxes, the overview AC column and dipo watch show it without a merge.
- [x] #3 A report criterion number that the story does not have is ignored, and the evidence label of progress.criteriaMet stays claimed.
- [x] #4 Tests cover a run whose report marks 2 of 3 criteria met (view and event show 2/3) and a restart that keeps the count.
<!-- AC:END -->
