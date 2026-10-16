---
id: DIPO-105
title: Keep worker thinking text and signatures out of events.ndjson
status: To Do
assignee: []
created_date: '2026-10-16 07:55'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/host/events.ts
  - packages/engine/src/host/main.ts
  - packages/engine/src/workers/claude-cli/interpret.ts
priority: medium
type: feature
ordinal: 95000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the run's raw event file holds no thinking text or thinking signatures, so the 0007 rule that run directories hold no transcripts also holds while a run is live.

Context: the worker host appends every worker stdout line to events.ndjson as is (packages/engine/src/host/events.ts, packages/engine/src/host/main.ts). Claude stream-json assistant messages carry thinking blocks with their text and signature. DIPO-96 only reads the duration and token estimate of a thinking block and never stores its text, but the raw line still sits in events.ndjson until the run ends and the file is deleted (0007 section 8 retention), and for tier R with privacy.keepRawEvents.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Thinking text and signature fields are removed from a stdout line before the host appends it (adapter-owned scrub, so the host and engine stay free of Claude specifics), and the rest of the line, including thinking duration and token fields, is unchanged.
- [ ] #2 Ingestion still derives the DIPO-96 thinking activity from the scrubbed line.
- [ ] #3 Tests cover a line with a thinking block, a redacted thinking block and a line without thinking; a recording replay shows no thinking text in events.ndjson.
<!-- AC:END -->
