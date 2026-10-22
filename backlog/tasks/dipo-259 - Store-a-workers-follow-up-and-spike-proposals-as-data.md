---
id: DIPO-259
title: Store a worker's follow-up and spike proposals as data
status: Refined
assignee: []
created_date: '2026-10-20 20:20'
updated_date: '2026-10-21 23:04'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies:
  - DIPO-256
  - DIPO-289
  - DIPO-291
references:
  - packages/engine/src/workers/types.ts
  - packages/engine/src/workers/claude-cli/report-schema.ts
  - packages/engine/src/run/verify-commit.ts
  - packages/engine/src/run/control.ts
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/src/retention/policy.ts
  - packages/engine/src/prompts/contract/implement.md
  - packages/engine/test/workers/report-schema.test.ts
  - packages/engine/test/db/
  - packages/engine/test/run/control.test.ts
  - packages/engine/test/run/verify-commit.test.ts
  - packages/engine/test/prompts/
priority: high
type: feature
ordinal: 136480
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker's done or blocked report can carry up to three proposals (follow-up or spike), and the engine stores them, deduplicated, without changing the story, so an improvement a worker sees beyond its story is kept as data instead of being lost in notes or done in place.

Context: the maintainer's decision D6 of 2026-10-20 (answer A): DIPO-166 is split. This story is the first part (166a): the report field and the proposals table. DIPO-166 keeps the rest: the desk listing (after DIPO-158), proposal.accept and proposal.dismiss with their events, the Backlog draft through the lane and the CLI (0020 section 11c, sections 14 and 15). In the M1 runs follow-ups were written into notes that nothing acts on (docs/research/2026-10-20-dipo-run-gaps.md section 5, item 9). WorkerReport is in packages/engine/src/workers/types.ts and its schema in packages/engine/src/workers/claude-cli/report-schema.ts; a done report is handled in packages/engine/src/run/verify-commit.ts and a blocked one in packages/engine/src/run/control.ts; migrations are registered in packages/engine/src/db/schema.ts with a retention tier in packages/engine/src/retention/policy.ts (the newest migration on main is 0040).

```dipo
branch: "DIPO-259/store-worker-proposals"
unknowns: []
test_plan:
  entries:
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
- [ ] #1 WorkerReport gains `proposals` (kind follow-up or spike, title, outcome, why, optional paths; at most 3) in done and blocked reports, in the type and the report JSON schema with length caps
- [ ] #2 A proposals table (office, story key, run, kind, title, outcome, why, paths, hash, state open, times; retention tier S) has a migration registered in packages/engine/src/db/schema.ts and a TABLE_RETENTION line, and stores each proposal of a report, deduplicated by a hash of its title and paths
- [ ] #3 Storing proposals changes nothing about the story's status, the run's end or the commit
- [ ] #4 The worker contract in packages/engine/src/prompts/contract/implement.md says, with tool-neutral wording, to put follow-ups and spike ideas in proposals instead of notes or extra work, and its golden is updated
- [ ] #5 Tests cover the schema caps, storing from a done and a blocked report, the dedupe and the migration
<!-- AC:END -->
