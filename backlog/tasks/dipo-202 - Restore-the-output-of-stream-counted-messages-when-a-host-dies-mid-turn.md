---
id: DIPO-202
title: Restore the output of stream-counted messages when a host dies mid-turn
status: Ready
assignee: []
created_date: '2026-10-18 08:55'
updated_date: '2026-10-18 14:29'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/ingest/usage.ts
  - packages/engine/src/ingest/transcript.ts
  - packages/engine/src/ingest/ingestor.ts
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/test/ingest/
  - packages/engine/test/db/
  - packages/engine/test/recordings/transcripts/
priority: medium
type: bug
ordinal: 191000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: when a worker host dies mid-turn after an earlier turn ended, the run's output tokens include the output of the messages the stream had already counted in the dying turn, read from the transcript, without counting any message twice.

Context: DIPO-134 (PR #200) and its review. The transcript recovery restores the output of a message only while the agent has had no turn end yet (outputOpen, packages/engine/src/ingest/usage.ts). A message the stream counted in a later turn keeps its input, but its output never arrives because the turn's result never came, so a host that dies in its second or later turn still undercounts output. The DIPO-134 worker named this in its notes: no marker tells whether the turn totals already include a message's output. usage_messages (packages/engine/src/db/migrations/0004-ingest.ts) has no such column and usage_totals has no last-turn-end time (its updated_at changes on every write), so the marker likely needs a migration, registered in packages/engine/src/db/schema.ts, and the turn end that sets it is in packages/engine/src/ingest/ingestor.ts or applyTurnTotals in usage.ts.

```dipo
branch: "DIPO-202/dying-turn-output"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(integration) a scrubbed transcript fixture of two turns, the host dying in the second after the stream counted one of its messages, restores that message's output once and a second pass adds nothing"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The engine knows, per stored message, whether its output is already in the turn totals (for example the messages counted after the agent's last turn end), and the transcript recovery adds the transcript's output for those messages only
- [ ] #2 A test replays a scrubbed fixture under packages/engine/test/recordings/transcripts/ in which the host dies in its second turn after the stream counted one message of that turn; the expected output total is written as literals from the fixture lines, and a second pass adds nothing
- [ ] #3 The DIPO-134 tests pass unchanged
<!-- AC:END -->
