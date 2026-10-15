---
id: DIPO-83
title: 'Show commands, thinking and open questions in the live agent detail'
status: To Do
assignee: []
created_date: '2026-10-15 11:34'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-55
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
