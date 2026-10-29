---
id: DIPO-368
title: Remove the worker transcript tailer
status: Refined
assignee: []
created_date: '2026-10-29 08:06'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-351
references:
  - packages/engine/src/ingest/transcript.ts
  - packages/engine/src/run/reattach.ts
priority: low
type: chore
ordinal: 348000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: usage comes from the worker host's events only, and the transcript tailer, its ingest cursors and its reattach and resume-check paths are gone.

From PR #417 (DIPO-347) on 2026-10-28: with the hooks gone, nothing records a transcript path any more (recordTranscriptPath was removed), so ingest/transcript.ts only reads a cursor an earlier binary stored. 0008 lists the tailer as replaced. Removing it touches run/reattach.ts and the resume check.

```dipo
branch: "DIPO-368/remove-transcript-tailer"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a reattached run with an old transcript cursor resumes and counts usage from host events only"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 packages/engine/src/ingest/transcript.ts and every caller are removed, and a run's usage still comes from the host's events
- [ ] #2 ingest_cursors rows of source kind transcript are dropped by a migration tested on a database with rows, and fresh equals migrated
- [ ] #3 Reattach and the resume check work without a transcript cursor, with a test for a run an earlier binary left with one
<!-- AC:END -->
