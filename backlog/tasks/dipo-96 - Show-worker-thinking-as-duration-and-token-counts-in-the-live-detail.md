---
id: DIPO-96
title: Show worker thinking as duration and token counts in the live detail
status: To Do
assignee: []
created_date: '2026-10-15 16:49'
labels:
  - 'tier:S'
milestone: m-0
dependencies:
  - DIPO-83
references:
  - packages/engine/src/workers/claude-cli/
  - packages/engine/src/ingest/
  - packages/tui/src/detail.tsx
priority: low
type: feature
ordinal: 86000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the live agent detail shows that the worker is thinking and for how long, as a line like [thinking] 0.4s ~292 tokens, without any thinking text.

Context: the DIPO-83 notes (AC3 investigation, 2026-10-15) found that stream-json thinking blocks always have empty text; what exists is thinking_duration_ms on assistant lines, system/thinking_tokens lines with estimated_tokens, and thinking token totals in the result. Option 1 of that proposal (counts only) needs no 0007 section 8 change. Today the adapter only lists thinking_tokens as a known subtype for liveness (packages/engine/src/workers/claude-cli/schema.ts:185-199) and nothing maps it to an event; no [thinking] line exists anywhere.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The Claude adapter maps thinking_duration_ms and system/thinking_tokens to a neutral activity event (kind thinking, ms, estimated tokens); the engine stays free of Claude field names.
- [ ] #2 Ingestion stores one short line per thinking block, [thinking] <seconds>s ~<tokens> tokens, and the live detail now-line shows it.
- [ ] #3 No thinking text or signature is stored or sent.
- [ ] #4 Replay tests on a recording with thinking show the lines.
<!-- AC:END -->
