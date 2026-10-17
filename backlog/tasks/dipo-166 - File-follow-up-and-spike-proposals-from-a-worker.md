---
id: DIPO-166
title: File follow-up and spike proposals from a worker
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-17 13:15'
labels:
  - 'tier:M'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-160
  - DIPO-158
references:
  - packages/contract/src/
  - packages/contract/schema/
  - packages/engine/src/workers/
  - packages/engine/src/run/
  - packages/engine/src/backlog/lane/
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/src/retention/
  - packages/engine/src/reads/hello.ts
  - packages/engine/src/features.ts
  - packages/daemon/src/
  - packages/cli/src/
  - packages/engine/test/run/
  - packages/engine/test/db/
priority: high
type: feature
ordinal: 155000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: report proposals are stored, shown on the desk, and accepted ones become Backlog drafts through the backlog lane, so improvements a worker sees beyond its story reach the maintainer instead of being done in place.

Context: implements ADR 0020 section 11c (improvements beyond the story; maintainer decision c), the proposals table of section 15 and the proposal commands and events of section 14.

```dipo
branch: "DIPO-166/worker-follow-up-proposals"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) proposals from a report are stored, a repeat with the same title and paths is deduped, and the fourth is dropped"
    - kind: "automated"
      check: "(unit) accept creates a draft through lane b with the outcome and references, and dismiss closes it"
    - kind: "automated"
      check: "(migration) proposals exists with retention tier S"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 WorkerReport gains proposals (kind follow-up or spike, title, outcome, why, optional paths; at most 3) in any done or blocked report, with length caps in the schema
- [ ] #2 A proposals table (story key, run, kind, title, outcome, why, paths, hash, state, decided by, draft id, times; retention tier S) stores each proposal deduped by a hash of title and paths, emits proposal.filed, and changes nothing about the story's own status
- [ ] #3 The desk lists open proposals, spike before follow-up, each with dipo propose accept <id> and dipo propose dismiss <id>
- [ ] #4 proposal.accept creates a Backlog draft through lane b with backlog draft create, carrying the title, the outcome line, the paths as references and the source story in the description; proposal.dismiss closes the proposal; both emit proposal.closed, behind capability flag proposals in reads/hello.ts
- [ ] #5 dipo propose accept|dismiss <proposal> exists in the CLI and sends proposal.accept or proposal.dismiss
<!-- AC:END -->
