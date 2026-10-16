---
id: DIPO-106
title: Store worker compactions as facts
status: To Do
assignee: []
created_date: '2026-10-16 07:55'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/ingest/ingestor.ts
  - packages/engine/src/workers/types.ts
  - packages/engine/src/workers/claude-cli/interpret.ts
priority: low
type: feature
ordinal: 96000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: each context compaction of a worker session is stored with its pre-compaction token count, so the run detail and later reports can show when and how often a session compacted.

Context: the Claude adapter emits a compacted event (preTokens) from compact_boundary and PostCompact (packages/engine/src/workers/types.ts, packages/engine/src/workers/claude-cli/interpret.ts), and 0008 section 3 says it is stored as a fact (research 6.2). DIPO-100 found that ingestion does not store it anywhere (packages/engine/src/ingest/ingestor.ts).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Ingestion stores each compacted event as a fact on the run and agent with preTokens and the time, once per compaction (a PostCompact and compact_boundary pair is one compaction).
- [ ] #2 The run detail read returns the run's compactions (count and the latest preTokens) through the contract, additively.
- [ ] #3 Tests cover a replayed recording with a compaction and the dedupe of the pair.
<!-- AC:END -->
