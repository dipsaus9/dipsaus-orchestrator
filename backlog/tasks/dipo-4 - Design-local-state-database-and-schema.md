---
id: DIPO-4
title: Design local state database and schema
status: To Do
assignee: []
created_date: '2026-10-09 19:17'
updated_date: '2026-10-09 19:44'
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
Outcome: an ADR choosing the local database (per project, gitignored) and defining its schema and ownership line with Backlog.md and git (docs/decisions/0001). Cover runs, worker events and output, loop counts, cost, reviewer verdicts, parked reasons, gate decisions, process state, migrations, and the startup reconcile against git and Backlog.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 ADR docs/decisions/0007-state-database.md records database choice, schema outline and migration strategy
- [ ] #2 ADR defines the reconcile procedure and which side wins per field
- [ ] #3 Maintainer approved the decision
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Scope addition (decision 0011 item 10): store usage per story, role and tier with budgets, so cost efficiency and trends can be reported.
<!-- SECTION:NOTES:END -->
