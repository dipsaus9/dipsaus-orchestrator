---
id: DIPO-448
title: >-
  Keep a planning session's decisions and continue it in a fresh Claude session
  when needed
status: Ready
assignee: []
created_date: '2026-11-05 20:51'
updated_date: '2026-11-06 07:15'
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
- [ ] #1 dipo stores a record per planning session in its database: each confirmed choice, filed or edited story and open question, in order
- [ ] #2 When the context nears full, dipo ends the Claude session and starts a fresh one whose first message code builds from the record
- [ ] #3 A session that continues after its Claude session ended, after an idle end or a daemon restart, continues in a fresh Claude session built from the record
- [ ] #4 An event says the session continued in a fresh Claude session, and ADR 0007 lists the record
<!-- AC:END -->
