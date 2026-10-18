---
id: DIPO-134
title: Read worker usage from the transcript when a worker host died
status: Done
assignee: []
created_date: '2026-10-16 14:39'
updated_date: '2026-10-18 09:51'
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
      check: "(integration) a scrubbed transcript fixture under packages/engine/test/recordings/ for a host that died mid-turn restores the missing usage once, and a second pass adds nothing"
    - kind: "automated"
      check: "(unit) the adapter's transcript parser ignores unknown lines and refuses an unsupported Claude Code version"
    - kind: "automated"
      check: "(unit) subagent transcripts add the per-subagent usage the stream lacked"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The hook relay records transcript_path from SessionStart and agent_transcript_path from SubagentStop for the run
- [x] #2 When a worker host died without exit.json, the engine reads the session's transcript from the stored byte offset and stores the usage it lacked, once per message id, so restored totals are not counted twice
- [x] #3 The transcript parser lives in the Claude adapter behind the worker port, keeps only message id, model and usage, ignores lines it does not understand, and is gated by claude_code_version
- [x] #4 Subagent transcripts (agent_transcript_path) are read for the per-subagent detail the stream lacked
- [x] #5 Tests replay a scrubbed transcript fixture under packages/engine/test/recordings/: a host that died mid-turn, a line of an unknown shape, an unsupported Claude Code version, and a second pass that adds nothing
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M570X9YW0B5JZVWKZ8G20QPJ (Sonnet medium, 118 turns, about $2.48, 9 min) reported done, all five criteria, In Review on DIPO-134/transcript-usage-tailer. 10 permission denials: a cd into a recordings folder narrowed its Edit rules (G22, DIPO-192 and DIPO-193), and seven cd compound commands were denied. It wrote packages/engine/src/retention/ outside its References, then used the existing ingest_cursors and usage_messages storage instead; the final diff has no retention change. Verify outside the sandbox on DIPO-134/transcript-usage-tailer-finish (origin/main merged in): 3264 pass, 2 skip, 0 fail.

Maintainer side: review blocked once on criterion 2. (a) A resumed session names the same transcript file, so its cursor read the earlier agent's messages again; recordTranscriptUsage now skips a message id another agent of the same run stored (fixture recordings/transcripts/resumed/, test 'a resumed session'). (b) RunReattacher.#closeFollowed ended a followed host that died without exit.json without reading the transcript; the lost-mode recovery moved into recoverLostUsage (ingest/transcript.ts), used by ExitOutcomes and #closeFollowed (new reattach test). Each fix fails its new test when broken. Verify after the fix: 3266 pass, 2 skip, 0 fail. Re-review passed.

Left open (follow-ups): when a host dies mid-turn after an earlier turn ended, messages the stream already counted in that turn get no output restored; the parser accepts every 2.1.x from 2.1.296 while only a 2.1.296 recording covers it; the Ingestor class was already over 400 lines and grows by 14. Question for the maintainer: whether 0008 gets a note naming the optional readTranscript on the worker port and the per-subagent detail in ingest_cursors.parse_state.

Answered (maintainer, 2026-10-18): the 0008 note is approved and written (0008 Amendments, 2026-10-18, DIPO-134).
<!-- SECTION:NOTES:END -->
