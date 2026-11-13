---
id: DIPO-492
title: Confirming a planning proposal answers at once and files in the background
status: Done
assignee: []
created_date: '2026-11-13 09:09'
updated_date: '2026-11-13 09:59'
labels:
  - 'tier:M'
milestone: m-3
dependencies: []
references:
  - packages/engine/src/run/planning-session.ts
  - packages/engine/src/backlog/lane/planning.ts
  - packages/engine/src/backlog/lane/lane.ts
  - packages/engine/src/backlog/lane/desk.ts
  - packages/contract/src/office.ts
  - packages/engine/test/run/planning-world.ts
  - packages/engine/test/run/planning-filing.test.ts
  - packages/tui/src/planning.tsx
modified_files:
  - packages/cli/src/story-commands.test.ts
  - packages/client/src/ready-text.ts
  - packages/client/test/unit/ready-text.test.ts
  - packages/contract/schema/commands.schema.json
  - packages/contract/src/office.ts
  - packages/contract/test/fixtures.ts
  - packages/engine/src/run/planning-session.ts
  - packages/engine/src/run/planning.ts
  - packages/engine/test/run/planning-background-flush.test.ts
  - packages/engine/test/run/planning-filed-stories.test.ts
  - packages/engine/test/run/planning-filing.test.ts
  - packages/engine/test/run/planning-ready.test.ts
  - packages/engine/test/run/planning-triage.test.ts
  - packages/engine/test/run/planning-world.ts
  - packages/engine/test/run/story-ready.test.ts
  - packages/tui/src/home.tsx
  - packages/tui/src/queue.test.tsx
priority: high
type: bug
ordinal: 464000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want confirming a proposal in the planning view, and setting stories Ready from the Queue, to answer at once and file in the background, so that the TUI never freezes for ten seconds while dipo pushes and opens its backlog PR.

M3 (0022), a bug from the maintainer's M4 planning hand test on 2026-11-12. The daemon log: the first `planning.confirm` at 13:41:08 answered after 8983 ms and one at 13:27:34 after 10658 ms; the confirms after them took about 44 ms, because the lane's branch was held then and the flush did nothing (0010). The TUI waits on the command, so for those ten seconds the keys seem dead.

Cause: `confirm` in packages/engine/src/run/planning-session.ts:790-845 journals the proposal's changes (`#journal`, :818) and then awaits `lane.flush(last)` (:827) before it answers. That flush (packages/engine/src/backlog/lane/planning.ts:312-322, then `OfficeLane.flush`, packages/engine/src/backlog/lane/lane.ts:422-470) fetches, applies the operations through the Backlog CLI, commits, pushes, opens the backlog PR and sets auto-merge, all inside the command. `story.ready` (packages/engine/src/run/planning.ts:228-280, the Queue's `Y` and `dipo ready`) awaits the same flush at :273.

The fix: `planning.confirm` and `story.ready` answer once the proposal's operations are journaled, and the flush runs after the answer, through the lane as now. The card shows `filing…` from the confirm's answer and `filed as DIPO-n` when the flush applied it, through a `planning.updated` the flush's end appends; a flush that fails or closes the change shows on the card as `failed` with the lane's reason, as a failed proposal does today, and a lane that stays stuck reaches the desk through the existing stuck-lane item (packages/engine/src/backlog/lane/desk.ts:1-5, DIPO-401), not a new one. The `[dipo]` note for the session (planning-session.ts:830-834) is added when the flush ended, with the filed ids, so the next message still names them. The lane's order and its hold rule (0010) stay: operations apply in journal order, two quick confirms are flushed in that order, and a held branch still applies nothing. A daemon stop during the background flush leaves the operations journaled, and the lane's replay at start files them, as for any journaled operation. The `flush` field of both command results (packages/contract/src/office.ts:520-540 and :571-583) goes, as the answer comes before any flush; their comments say the filing follows in the view and the lane events. The TUI's "queued: waits for backlog PR #n" note then comes from the store's lane progress (`lane`, the `lane.progress` event of DIPO-481, packages/client/src/store/office-store.ts:153-154), not from a command result: the Queue's ready result (`readyLines` and `readyWaitingText`, packages/client/src/ready-text.ts:30-55) names the backlog PR the lane reports for the story. The idea-accept note in packages/tui/src/actions.ts:515-528 reads `idea.accept`'s own `flush`, which this story does not change.

Replaces: the flush awaited inside the filing commands `planning.confirm` and `story.ready` (the Queue's `Y`, `dipo ready`). Each answers once its operations are journaled, and the lane's outcome reaches the view through `planning.updated` and the lane events. `planning.ready` is left as is because DIPO-497 (split from DIPO-495) removes it. Out of scope, still flushing inside their commands: park, resumeHold and drop (packages/engine/src/run/planning.ts:385, :432, :589) and `idea.accept` (packages/engine/src/run/idea-answers.ts:299).

Not a guard: no deny rule, sandbox setting or permission check changes (R30 does not apply).

No ADR line changes: 0022 and 0010 say what is filed and in which order, not when the command answers.

Tier M: two commands' answers split from their flush, the view and note after it, and the order under concurrent confirms.

```dipo
branch: "DIPO-492/planning-confirm-answers-at-once"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit, planning-world) with a lane whose push waits on a promise the test holds, planning.confirm answers with state confirmed and no flush field before the push resolves; the view shows the proposal filing"
    - kind: "automated"
      check: "(unit, planning-world) once the held push resolves, a planning.updated shows the proposal filed with its id, and the session's next message carries the [dipo] note naming that id"
    - kind: "automated"
      check: "(unit, planning-world) a background flush that throws LaneFlushError leaves the proposal failed with the lane's reason in the view and its operations journaled"
    - kind: "automated"
      check: "(unit, planning-world) two confirms sent before the first flush ends are filed in confirm order, and on a held branch a confirm answers at once and applies nothing"
    - kind: "automated"
      check: "(unit, planning-world) with a lane whose push waits on a held promise, story.ready answers with the story queued and no flush field before the push resolves, and the Queue's ready result names the backlog PR from the lane progress once it is open"
    - kind: "automated"
      check: "(fail-closed: the real planning lane and the Backlog CLI on a fixture-built office with a slow fake remote) confirm answers before the push ends, and the filed task is on the lane's branch after it"
    - kind: "manual"
      check: "On the scratch repository, in a planning session confirm a proposal while the lane's branch is not held and press keys at once"
      expect: "The card shows filing… at once, the keys work during the flush, and the card shows filed as DIPO-n when dipo's backlog PR is open"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 planning.confirm and story.ready answer once their operations are journaled, before the lane's flush, and their results have no flush field
- [x] #2 The card shows filing… from the answer and filed as DIPO-n when the background flush applied it, through a planning.updated the flush's end appends
- [x] #3 A background flush that fails or closes the change leaves the proposal failed with the lane's reason in the view and its operations journaled; a stuck lane reaches the desk through the existing stuck-lane item
- [x] #4 The session's [dipo] note naming the filed ids is added when the flush ended
- [x] #5 The Queue's ready result names the backlog PR a queued story waits on from the store's lane progress, not from a command result
- [x] #6 Confirms and ready commands flush in journal order, and a held branch still applies nothing (0010)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-13 09:59 UTC
- Criteria met: 6 of 6 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 1, failed 0
- Budget used: 174,493 of 800,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 0
<!-- SECTION:FINAL_SUMMARY:END -->
