---
id: DIPO-106
title: Store worker compactions as facts
status: Done
assignee: []
created_date: '2026-10-16 07:55'
updated_date: '2026-10-16 19:20'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/workers/types.ts
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/src/db/
  - packages/engine/test/
  - packages/engine/src/ingest/
  - packages/engine/src/retention/
  - packages/engine/src/workers/claude-cli/schema.ts
priority: low
type: feature
ordinal: 96000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: each context compaction of a worker session is counted in the run's and agent's usage stats with its pre-compaction token count, as 0008 section 4 lists compactions among them.

Context: the Claude adapter emits a compacted event (preTokens) from compact_boundary and PostCompact (packages/engine/src/workers/types.ts, packages/engine/src/workers/claude-cli/interpret.ts), and 0008 says it is stored (section 3: as a fact, research 6.2; section 4: compactions are a per-run and per-agent usage stat). DIPO-100 found that ingestion does not store it anywhere (packages/engine/src/ingest/ingestor.ts). The per-run and per-agent usage facts live in packages/engine/src/ingest/usage.ts (usage_totals, usage_messages). A new office-scoped table needs a TABLE_RETENTION line in packages/engine/src/retention/policy.ts (0007 section 7; packages/engine/test/retention/stats.test.ts checks every table has one) and a delete in packages/engine/src/retention/run.ts. No recording under packages/engine/test/recordings has a compaction, so the test uses a hand-written stream fixture. No contract read returns per-run usage counters yet, so showing compactions to clients is a later story.

```dipo
branch: "DIPO-106/store-compactions-as-facts"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(integration) a replayed recording or hand-written stream fixture with one compaction stores one compaction fact with preTokens and time"
    - kind: "automated"
      check: "(unit) a PostCompact and compact_boundary pair stores one compaction fact"
    - kind: "automated"
      check: "(unit) the per-run and per-agent usage stats give the compaction count and the latest preTokens, and run retention deletes them"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Ingestion stores each compacted event for the run and agent with preTokens and the time, once per compaction (a PostCompact and compact_boundary pair is one compaction).
- [x] #2 The per-run and per-agent usage stats give the compaction count and the latest preTokens.
- [x] #3 Tests cover a replayed recording with a compaction and the dedupe of the pair.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Set Ready by the maintainer on 2026-10-16 (DIPO-115 cutover step 2) after dipo gate passed on main.

Review fixes (DIPO-106/compactions-review-fixes, on top of dipo's delivery): the neutral compacted event's preTokens is optional and absent when the adapter had no count (a hook-only compaction no longer reports 0); compactions.pre_tokens is nullable and stores null then, and readCompactions gives latestPreTokens null. The 0030 comment names no adapter lines and says at is the ingest time. New tests: a hook-only compaction stores one row with pre_tokens null; a second agent in the same run gives different agent and run counts; a second pass, re-track or restarted ingestor on a fully ingested file stores no new row. bun run verify green (3122 pass, 2 skip).
<!-- SECTION:NOTES:END -->
