---
id: DIPO-100
title: Correct compaction preTokens when PostCompact arrives first
status: To Do
assignee: []
created_date: '2026-10-15 16:49'
labels:
  - 'tier:S'
milestone: m-0
dependencies:
  - DIPO-59
references:
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/src/workers/types.ts
priority: low
type: feature
ordinal: 90000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a compaction always reports the token count before compaction, also when the PostCompact hook arrives before the compact_boundary line.

Context: the adapter emits one compacted event per compaction, from whichever signal comes first (DIPO-59, DIPO-42 review). When the hook comes first it emits preTokens 0 (packages/engine/src/workers/claude-cli/interpret.ts:1002-1007), and the later compact_boundary with the real pre_tokens emits nothing (packages/engine/src/workers/claude-cli/interpret.ts:507-518), so the 0 is never corrected.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 When compact_boundary follows a hook-first compaction, the real pre_tokens reaches the stored compaction fact (a correcting event or an update of the same fact), without counting the compaction twice.
- [ ] #2 Replay tests cover both orders and show the same compaction count and preTokens.
<!-- AC:END -->
