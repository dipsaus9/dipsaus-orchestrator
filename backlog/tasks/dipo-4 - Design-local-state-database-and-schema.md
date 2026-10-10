---
id: DIPO-4
title: Design local state database and schema
status: To Do
assignee: []
created_date: '2026-10-09 19:17'
updated_date: '2026-10-10 11:04'
labels:
  - architecture
milestone: m-0
dependencies:
  - DIPO-1
priority: high
type: spike
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an ADR choosing the local database (per office, gitignored) and defining its schema and ownership line with Backlog.md and git (docs/decisions/0001). Cover runs, worker events and output, loop counts, usage and cost per story, role and tier against budget, reviewer verdicts, parked reasons, gate decisions, test results, process state, product run knowledge from repository scans (DIPO-9), migrations, and the startup reconcile against git and Backlog.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 ADR docs/decisions/0007-state-database.md records database choice, schema outline and migration strategy
- [ ] #2 ADR defines the reconcile procedure and which side wins per field
- [ ] #3 Maintainer approved the decision
- [ ] #4 Schema stores usage per story, role and tier against budget so cost efficiency and trends can be reported
- [ ] #5 Schema stores product run knowledge from repository scans and when it was last scanned
- [ ] #6 Schema stores facts only; displayed status is derived when read, and a change log feeds the event stream (research idea 1)
- [ ] #7 Usage is stored as tokens plus an estimated cost from a versioned pricing catalog (research idea 4)
- [ ] #8 Telemetry stores no prompts or command bodies unless the maintainer opts in (research idea 11)
- [ ] #9 Transcript usage ingestion resumes from a stored byte offset after a restart (research idea 21)
- [ ] #10 ADR defines the office directory layout on disk: where an office's database, logs and runtime files live, and what is gitignored
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Scope addition (decision 0011 item 10): store usage per story, role and tier with budgets, so cost efficiency and trends can be reported.
<!-- SECTION:NOTES:END -->
