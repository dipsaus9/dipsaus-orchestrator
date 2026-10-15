---
id: DIPO-83
title: 'Show commands, thinking and open questions in the live agent detail'
status: To Do
assignee: []
created_date: '2026-10-15 11:34'
updated_date: '2026-10-15 12:04'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-55
references:
  - packages/engine/src/ingest/output.ts
  - packages/engine/src/ingest/ingestor.ts
  - packages/engine/src/workers/types.ts
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/src/workers/claude-cli/schema.ts
  - packages/engine/src/run/hosts.ts
  - packages/engine/src/office
  - packages/daemon/src
  - packages/contract/src/software.ts
  - packages/contract/src/fixtures.ts
  - packages/contract/src/version.ts
  - packages/tui/src/detail.tsx
  - packages/tui/src/overview.tsx
  - packages/engine/test
  - packages/tui/src/detail.test.tsx
  - packages/tui/src/overview.test.tsx
priority: medium
ordinal: 73000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the maintainer can see what a running worker actually does: with the opt-in on, each Bash line in the live agent detail shows the command it ran; the detail shows the story's open questions; and thinking is shown when Claude sends it.

Context: maintainer feedback from the DIPO-55 hand test (2026-10-15): 'It says run bash, but I want to know what it runs.' and 'Where is it thinking? Does it have questions?'. ADR 0007 section 8 stores only assistant text and one tool line (name and path) per call by default; it already approves the machine-local opt-in `privacy.storeCommandBodies` in .dipo/office.local.yaml (tool inputs in output_chunks), not built yet. The maintainer chose to build that opt-in, not to change the default. A real run's raw events (TASK-1, run_01M4ZFJ8S2HSV95CC56HGHJQWF) had thinking blocks with empty text in claude -p stream-json, so showing thinking first needs a check of what Claude sends and which flag (if any) turns on its text; showing it may need a privacy decision. Open questions exist since DIPO-59 (question.asked, story.detail questions).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 With privacy.storeCommandBodies on in .dipo/office.local.yaml, a Bash tool line in output_chunks and the live agent detail reads `[tool] Bash <command>` (one line, long commands cut with a marker); with it off (the default) nothing changes. The overview shows when the opt-in is on (0007 section 8).
- [ ] #2 The live agent detail lists the story's open questions (kind, text, age) and says how to answer them.
- [ ] #3 Investigate without a live session first, from recordings and raw event files: what Claude sends for thinking in stream-json and whether a flag gives its text. If text is available, propose (do not build) how to show it and what privacy rule it needs, for the maintainer to decide.
- [ ] #4 Tests cover the opt-in on and off, the question list, and secret-looking command text staying out when the opt-in is off.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
AC3 thinking investigation (2026-10-15, no live session; raw run run_01M4ZFJ8S2HSV95CC56HGHJQWF read-only, committed recordings, claude --help of 2.1.300):
- Every assistant message that thought carries a content block {type: thinking, thinking: "", signature: <opaque base64, 0.8 to 2.3 KB>}. The text is always empty, in the raw run and in every recording (budget-engine-cap, permission-denied and others: thinking len:0). The signature is an opaque blob for API round trips, not readable text.
- The assistant line also carries thinking_duration_ms (400 in the raw run) and thinking_display: "updates" (159 recording lines, len:7). While the model thinks the CLI sends system/thinking_tokens lines with estimated_tokens and estimated_tokens_delta. The result has usage.output_tokens_details.thinking_tokens (235) and modelUsage.thinkingTokens.
- claude --help has no flag that returns thinking text. --include-partial-messages adds stream_event deltas, --forward-subagent-text forwards subagent text and thinking blocks; with thinking_display "updates" both are expected to carry the same empty text (not verified). Whether a settings key changes thinking_display in -p mode is unknown; settling that needs one live check.

Proposal (not built, for the maintainer):
1. Now, no privacy change: show that the worker thinks, not what. The adapter maps system/thinking_tokens and thinking_duration_ms to a neutral activity (kind thinking, tokens, ms); ingestion stores one line like [thinking] 0.4s ~292 tokens, so the detail's now line shows thinking. Counts only, so 0007 section 8 needs no change.
2. If a live check finds a setting that returns thinking text in stream-json: treat it like command bodies. A fourth machine-local opt-in privacy.storeThinking, off by default, only in .dipo/office.local.yaml, listed in the summary optIns and the overview's opt-in label, stored as one cut line [thinking] <text>. That needs a 0007 section 8 amendment (a fourth opt-in) and, per the 0017 M0 review rule, a version bump of office.local.yaml with an identity migration.
3. Next step: one live Haiku run on the scratch repo with --include-partial-messages (and any candidate setting) to see whether thinking text ever arrives.

AC1 decisions: the opt-in key privacy.storeCommandBodies already existed (default false, local only), so no config version bump. The Claude adapter reads the input beyond the path for Bash (command), Grep and Glob (pattern), WebFetch (url) and WebSearch (query); file contents and edit bodies stay out. Ingestion stores it only with the opt-in, read at every pass, as one line (whitespace and control characters collapsed, cut at 200 characters with [cut N more chars]). OfficeSummary gains the optional optIns (contract minor 1); the overview summary line and the worker pane title show opt-in storeCommandBodies.
<!-- SECTION:NOTES:END -->
