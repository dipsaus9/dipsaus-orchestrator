---
id: DIPO-448
title: >-
  Keep a planning session's decisions and continue it in a fresh Claude session
  when needed
status: In Progress
assignee: []
created_date: '2026-11-05 20:51'
updated_date: '2026-11-06 13:39'
labels:
  - 'tier:M'
milestone: m-3
dependencies:
  - DIPO-447
references:
  - packages/engine/src/db/migrations/
  - packages/engine/src/retention/policy.ts
  - packages/engine/src/run/session-run.ts
  - packages/engine/src/records/usage.ts
  - packages/contract/src/office.ts
  - docs/decisions/0007-state-database.md
modified_files:
  - docs/decisions/0007-state-database.md
  - packages/contract/schema/commands.schema.json
  - packages/contract/schema/events.schema.json
  - packages/contract/src/office.ts
  - packages/contract/src/work.test.ts
  - packages/contract/src/work.ts
  - packages/contract/test/fixtures.ts
  - packages/engine/src/db/migrations/0003-planning-records.ts
  - packages/engine/src/db/schema.ts
  - packages/engine/src/prompts/task/planning.md
  - packages/engine/src/prompts/templates.ts
  - packages/engine/src/records/planning-record.ts
  - packages/engine/src/records/usage.ts
  - packages/engine/src/retention/policy.ts
  - packages/engine/src/retention/run.ts
  - packages/engine/src/run/planning-session.ts
  - packages/engine/test/db/migrations.test.ts
  - packages/engine/test/prompts/task.test.ts
  - packages/engine/test/run/planning-record.test.ts
  - packages/engine/test/run/planning-session.test.ts
  - packages/engine/test/run/planning-world.ts
priority: high
type: feature
ordinal: 421000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want dipo to keep every decision of a planning session in its own record and continue the session in a fresh Claude session when the context fills or the session was stopped, so that a long planning session never loses what we decided.

M3 (0022), the maintainer's answer to a filling context. Needs DIPO-447.

A record per session in dipo's database (one table; the maintainer's office scope like other tables, 0007): each entry is a confirmed choice (question and answer), a filed or edited story id, or an open question, with its time. Entries are written by code when the maintainer confirms (DIPO-450 adds filed stories). When Claude's context nears full (from the usage dipo already counts, or a compaction fact) or a session continues after its Claude session ended (idle end, daemon restart), dipo ends that Claude session and starts a fresh one whose first message code builds from the record: the goal, the decisions, the filed stories and the open questions, plus the facts of DIPO-447's first message. An event says the session continued in a fresh session. Retention keeps a session's record until the session ends and then for the usual aged period.

Built by dipo where it can (maintainer's choice, 2026-11-05); a builder agent takes over if dipo gets stuck.

```dipo
branch: "DIPO-448/planning-decision-record"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) each confirmed choice, filed or edited story and open question is stored in the session's record in order"
    - kind: "automated"
      check: "(unit) near a full context, and on a continue after the Claude session ended or the daemon restarted, a fresh Claude session starts whose first message holds the goal, decisions, filed stories and open questions, and an event says so"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 dipo stores a record per planning session in its database: each confirmed choice, filed or edited story and open question, in order
- [x] #2 When the context nears full, dipo ends the Claude session and starts a fresh one whose first message code builds from the record
- [x] #3 A session that continues after its Claude session ended, after an idle end or a daemon restart, continues in a fresh Claude session built from the record
- [x] #4 An event says the session continued in a fresh Claude session, and ADR 0007 lists the record
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parked 2026-11-06 13:21 UTC: verify-failing
- Detail: required checks were red on 2 pushed heads (the CI cap is 2). Required check ci-ok failed on the pushed head.
- Run: run_01M6RDZS9GM3QCAP758JP8JEDV
- Criteria met: 4 of 4 (as the worker reported them)
- Loops: 0 of 5; CI attempts: 2 of 2
- Review rounds: 2, failed 1 of 3
- Budget used: 243,285 of 800,000 tokens; 70 of 200 turns; 18 of 90 minutes
- Last good commit: 1040a29b74d566591eed67b43ab9a573c829bfbc

Resumed 2026-11-06 13:30 UTC; grants: +1 CI attempt; note: CI fails only on the contract JSON Schema export (verify shard 3: commands, reads and work schema 'equals a fresh export'). main moved on (DIPO-449 merged): merge origin/main into the branch, run bun…
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-06 13:08 UTC
- Criteria met: 4 of 4 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 2, failed 1
- Budget used: 215,965 of 800,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 1
<!-- SECTION:FINAL_SUMMARY:END -->
