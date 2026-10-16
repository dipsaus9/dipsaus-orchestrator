---
id: DIPO-101
title: Give the agents table an adapter-neutral version column
status: Done
assignee: []
created_date: '2026-10-15 16:49'
updated_date: '2026-10-16 07:33'
labels:
  - 'tier:S'
milestone: m-0
dependencies: []
references:
  - packages/engine/src/db/migrations/
  - packages/engine/src/ingest/ingestor.ts
  - packages/engine/src/run/resume.ts
priority: low
type: feature
ordinal: 91000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine schema stores the worker tool version under a neutral name (adapter_version), so no engine table names Claude.

Context: the agents table has claude_code_version (packages/engine/src/db/migrations/0004-ingest.ts:29), written by ingestion (packages/engine/src/ingest/ingestor.ts:462) and read on resume (packages/engine/src/run/resume.ts:229-244). The rule in CLAUDE.md is to keep Claude specifics out of the engine.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A migration adds adapter_version (copied from claude_code_version, or a rename) and engine code reads and writes only the neutral name.
- [x] #2 The Claude adapter still maps claude_code_version from stream-json to the neutral field; no engine file outside workers/claude-cli names claude_code_version.
- [x] #3 Migration and resume tests pass with the neutral column.
<!-- AC:END -->
