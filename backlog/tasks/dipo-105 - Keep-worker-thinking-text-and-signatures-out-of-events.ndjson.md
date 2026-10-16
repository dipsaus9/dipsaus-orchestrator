---
id: DIPO-105
title: Keep worker thinking text and signatures out of events.ndjson
status: Refined
assignee: []
created_date: '2026-10-16 07:55'
updated_date: '2026-10-16 14:16'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/host/events.ts
  - packages/engine/src/host/main.ts
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/src/ingest/
  - packages/engine/src/workers/claude-cli/adapter.ts
  - packages/engine/src/workers/types.ts
  - packages/engine/test/
  - packages/daemon/src/worker-host.ts
  - packages/engine/src/index.ts
  - packages/engine/src/host/
  - packages/daemon/src/worker-host.test.ts
priority: medium
type: feature
ordinal: 95000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the run's raw event file holds no thinking text or thinking signatures, so the 0007 rule that run directories hold no transcripts also holds while a run is live.

Context: the worker host appends every worker stdout line to events.ndjson as is (packages/engine/src/host/events.ts, packages/engine/src/host/main.ts). Claude stream-json assistant messages carry thinking blocks with their text and signature. DIPO-96 only reads the duration and token estimate of a thinking block and never stores its text, but the raw line still sits in events.ndjson until the run ends and the file is deleted (0007 section 8 retention), and for tier R with privacy.keepRawEvents. The host is a separate process that may not import workers/claude-cli (dipo/no-claude-cli-import, 0004 DIPO-113 note) and reads only launch.json, so the adapter's scrub reaches it as declarative data in the LaunchPlan (packages/engine/src/host/protocol.ts strips unknown keys, so the schema there changes too), attached in packages/engine/src/workers/claude-cli/adapter.ts where the port wraps plan(), not in plan.ts; or it is injected where the daemon builds the host (packages/daemon/src/worker-host.ts).

```dipo
branch: "DIPO-105/scrub-thinking-from-events"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the scrub removes thinking text and signatures from a thinking line, handles a redacted_thinking line (stating whether its data field is removed), leaves a line without thinking byte-identical, and every output line parses as JSON with the thinking duration and token fields unchanged"
    - kind: "automated"
      check: "(unit) ingestion derives the DIPO-96 thinking activity from a scrubbed line"
    - kind: "automated"
      check: "(integration) a recorded stream replayed through the testkit fake process leaves no thinking text or signature in events.ndjson"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Thinking text and signature fields are removed from a stdout line before the host appends it (an adapter-owned scrub, so the host and engine stay free of Claude specifics); the line stays valid JSON and the rest of it, including the thinking duration and token fields, is unchanged.
- [ ] #2 Ingestion still derives the DIPO-96 thinking activity from the scrubbed line.
- [ ] #3 Tests cover a line with a thinking block, a redacted thinking block and a line without thinking; a replay of a recorded stream through the testkit fake process (packages/testkit/src/fake-process.ts) shows no thinking text in events.ndjson.
<!-- AC:END -->
