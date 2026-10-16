---
id: DIPO-134
title: Read worker usage from the transcript when a worker host died
status: Refined
assignee: []
created_date: '2026-10-16 14:39'
updated_date: '2026-10-16 14:48'
labels:
  - 'tier:M'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-105
  - DIPO-106
  - DIPO-107
  - DIPO-115
  - DIPO-128
references:
  - packages/engine/src/ingest/
  - packages/engine/src/workers/
  - packages/engine/src/hooks/
  - packages/engine/src/run/
  - packages/engine/test/
  - packages/engine/src/db/
priority: medium
type: feature
ordinal: 124000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a run's token usage stays correct when its worker host dies before writing exit.json, because the engine reads the missing usage from the Claude transcript.

Context: 0008 section 4 makes transcript tailing the second usage source: the hook relay records transcript_path (SessionStart) and agent_transcript_path (SubagentStop); a tailer reads them from a stored byte offset (research idea 21), keeps only message id, model and usage, ignores lines it does not understand, and runs only when a host died without exit.json, or for per-subagent detail the stream lacked. Its parser is version-gated by claude_code_version and covered by recordings; the transcript format is internal to Claude Code, so the parser belongs in the adapter (packages/engine/src/workers/claude-cli/, dipo/no-claude-cli-import) behind the worker port. It was M0 scope and was not built (2026-10-16 milestone review), so a budget can undercount after a host crash. Nothing stores the transcript paths today: run/resume.ts passes transcriptPath null, resume-check.ts finds the transcript by session id under the Claude projects directory, and the hook relay (packages/engine/src/workers/claude-cli/hooks.ts) drops transcript_path (SessionStart) and agent_transcript_path (SubagentStop). Storage exists: ingest_cursors with source_kind transcript and read_offset, and usage_messages keyed by message_id (packages/engine/src/db/migrations/0004-ingest.ts). DIPO-106 changes ingestion first. Found by the 2026-10-16 milestone review.

```dipo
branch: "DIPO-134/transcript-usage-tailer"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(integration) a recorded transcript fixture for a host that died mid-turn restores the missing usage once, and a second pass adds nothing"
    - kind: "automated"
      check: "(unit) the adapter's transcript parser ignores unknown lines and refuses an unsupported Claude Code version"
    - kind: "automated"
      check: "(unit) subagent transcripts add the per-subagent usage the stream lacked"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The hook relay records transcript_path from SessionStart and agent_transcript_path from SubagentStop for the run
- [ ] #2 When a worker host died without exit.json, the engine reads the session's transcript from the stored byte offset and stores the usage it lacked, once per message id, so restored totals are not counted twice
- [ ] #3 The transcript parser lives in the Claude adapter behind the worker port, keeps only message id, model and usage, ignores lines it does not understand, and is gated by claude_code_version
- [ ] #4 Subagent transcripts (agent_transcript_path) are read for the per-subagent detail the stream lacked
- [ ] #5 Tests replay a scrubbed transcript fixture under packages/engine/test/recordings/: a host that died mid-turn, a line of an unknown shape, an unsupported Claude Code version, and a second pass that adds nothing
<!-- AC:END -->
