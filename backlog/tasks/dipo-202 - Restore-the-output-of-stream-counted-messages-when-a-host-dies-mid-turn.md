---
id: DIPO-202
title: Restore the output of stream-counted messages when a host dies mid-turn
status: Done
assignee: []
created_date: '2026-10-18 08:55'
updated_date: '2026-10-19 07:21'
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
- [x] #1 The engine knows, per stored message, whether its output is already in the turn totals (for example the messages counted after the agent's last turn end), and the transcript recovery adds the transcript's output for those messages only
- [x] #2 A test replays a scrubbed fixture under packages/engine/test/recordings/transcripts/ in which the host dies in its second turn after the stream counted one message of that turn; the expected output total is written as literals from the fixture lines, and a second pass adds nothing
- [x] #3 The DIPO-134 tests pass unchanged
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M59FF7TA60YQXWVCAC3VF92N (Sonnet medium, 52 turns, about $0.73, 6 min) reported done, In Review on the story branch. Four compound commands were auto-denied (G7, DIPO-181). Migration 35 adds usage_messages.output_state (0 not in the turn totals, 1 in them, 2 restored from a transcript); applyTurnTotals marks the agent's messages 1, and transcript recovery adds output once for state 0 and only a higher output for state 2. A derived transcript recording (transcripts/second-turn) covers a host that died in its second turn.

Review passed; the reviewer's mutation checks each fail the new test. Fixed on top: the migration comment states the backfill's loss (in a database from before migration 35, a message the stream counted after its agent's last turn end is never restored) and the recording's meta lists its numeric edits. Behaviour change worth knowing: for an agent with no turn end, the totals' output now holds only messages the transcript has, not the stream placeholders of the others. The worker's note that Bun's db.run runs one statement is wrong: Bun's Database.run runs all; the project's SqliteConnection.run wrapper (db.query(sql).run()) runs the first only, and migrations go through exec. Verify outside the sandbox: 3427 pass, 2 skip, 0 fail; DIPO_TEST_CI=1 on ingest, db and run: 428 pass.

Process note: while checking the migration, the reviewer listed ~/Library/Application Support/dipo and copied the maintainer's real dipo.db into the session scratchpad, then migrated the copy. The real files were not changed; the copy was deleted, and agent briefs now forbid that path.
<!-- SECTION:NOTES:END -->
