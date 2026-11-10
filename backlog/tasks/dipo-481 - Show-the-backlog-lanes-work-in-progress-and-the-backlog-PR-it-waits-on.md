---
id: DIPO-481
title: Show the backlog lane's work in progress and the backlog PR it waits on
status: Refined
assignee: []
created_date: '2026-11-10 15:27'
updated_date: '2026-11-10 15:50'
labels:
  - 'tier:M'
milestone: m-6
dependencies:
  - DIPO-487
references:
  - packages/engine/src/backlog/lane/journal.ts
  - packages/engine/src/backlog/lane/lane.ts
  - packages/engine/src/backlog/lane/desk.ts
  - packages/engine/src/backlog/pr/records.ts
  - packages/engine/src/backlog/pr/merge.ts
  - packages/engine/src/platform/host.ts
  - packages/contract/src/office.ts
  - packages/tui/src/overview.tsx
  - packages/tui/src/desk.tsx
  - packages/tui/src/planning.tsx
  - docs/design/tui-v2/screens/02-floor.txt
  - docs/design/tui-v2/screens/07-plan.txt
  - docs/design/tui-v2/spec.md
priority: high
type: feature
ordinal: 453000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want to see each change dipo has queued for the backlog and the backlog PR it waits on, with that PR's CI state, so that I know an accept or a confirm is in progress somewhere instead of wondering whether it was lost.

M6 (TUI v2), because the gap is in what the views show: the lane itself works (M3). The maintainer's words (2026-11-10): "I want to see that it is in progress somewhere." Case: at 15:23 they accepted a desk proposal; the daemon log said `the planning lane holds its operations reason="the backlog PR of dipo/backlog-20261110T151823 has auto-merge on ...; new operations wait until it merges" pending=1` while dipo's backlog PR #656 ran CI. Nothing in the TUI or in `dipo desk` showed that the accept was queued, nor that confirmed planning stories wait for a backlog PR.

What main has (reuse it, one mechanism, 0001):
- The lane's journal holds every queued operation with its kind, subject, state, branch and PR (`openEntries`, packages/engine/src/backlog/lane/journal.ts:198), and the lane keeps why its last flush held or waited (`OfficeLane.stall`, `heldReason`, packages/engine/src/backlog/lane/lane.ts:322-333).
- The office's backlog PRs are records with number, URL, state and dipo's structural check (`openPrs`, packages/engine/src/backlog/pr/records.ts); the auto-merge round (packages/engine/src/backlog/pr/merge.ts) reads them each round. No read gives the PR's GitHub CI state yet: the story reads it through the code host port the auto-merge round already uses (packages/engine/src/platform/host.ts), never a second poll.
- A command's result says once what its flush did (`LaneFlush`, packages/contract/src/office.ts:275-292: opened, updated, held, waiting, merged...), and the desk shows a `PLANNING LANE` item only when an operation waits 30 minutes (`laneDeskItems`, packages/engine/src/backlog/lane/desk.ts, `LANE_STUCK_MS`). That desk item stays: it asks for the maintainer's hand; this story shows progress that needs no hand.

The engine adds one read of the lane's progress to `office.snapshot`, kept current by an event when the journal or the backlog PR changes: each open operation (what it does in words: an accepted idea filed as a draft, a confirmed story filed, an edit, a story set Ready, a park; its subject; queued, on the branch or in the PR; since when) and the open backlog PR it waits on (number, URL, CI running, passed or failed, auto-merge on, merged). The TUI joins what the engine sent and derives nothing (0009).

Where the maintainer sees it: the Floor shows one BACKLOG line while any operation is open ("2 changes wait for backlog PR #656 · CI running"), and Enter on it lists them; a Desk accept whose flush was held says "queued: waits for backlog PR #656" and the idea shows queued until filed; in the Plan view the "filing…" line of a confirmed proposal (DIPO-487 owns that line) gets this read's data: "filing… waiting for backlog PR #656, CI running", then "filed as DIPO-n". `dipo desk` is not changed by this story. Needs DIPO-487 for the Plan view's line.

Tier M: one engine read with one event, the CI state through an existing port, and three places in the TUI.

```dipo
branch: "DIPO-481/backlog-lane-progress"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit, fixture-built office) with an accept and a confirm journaled and the backlog PR open with auto-merge on and CI running, office.snapshot lists both operations in words with their state and since, and the PR with number, CI running and auto-merge on; after the PR merges the list is empty and an event said so"
    - kind: "automated"
      check: "(unit) the read is built from the lane journal and the backlog PR records, and the CI state comes through the code host port's fake; no second journal table or poll exists"
    - kind: "automated"
      check: "(unit) the Floor renders one BACKLOG line with the count, the PR number and its CI state while an operation is open, none without one, and Enter lists the operations"
    - kind: "automated"
      check: "(unit) a Desk accept answered with a held flush shows 'queued: waits for backlog PR #n' and the idea row shows queued until the snapshot says filed"
    - kind: "automated"
      check: "(unit) in the Plan view a confirmed proposal's filing line shows the PR and its CI state from the read, and 'filed as DIPO-n' once filed"
    - kind: "manual"
      check: "On the scratch repository, while dipo's backlog PR runs CI, accept a desk proposal and confirm a story in a planning session"
      expect: "The Floor's BACKLOG line names the PR and 'CI running', the Desk says the accept is queued, the Plan view says the story waits for the PR, and all three clear once it merges"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 office.snapshot carries the backlog lane's progress: each open operation in words with its subject, state and since, and the open backlog PR it waits on with number, URL, CI state, auto-merge and merged; an event says when it changes
- [ ] #2 The read is built from the lane journal (openEntries) and the backlog PR records, and the PR's CI state comes through the code host port the auto-merge round uses; no second journal or poll is added
- [ ] #3 The Floor shows one BACKLOG line while an operation is open, with the count, the PR number and its CI state, and Enter lists the operations; with none open the line is absent
- [ ] #4 A Desk accept whose flush was held says it is queued and which backlog PR it waits on, and the idea shows queued until it is filed
- [ ] #5 In the Plan view a confirmed proposal's filing line (DIPO-487) shows the backlog PR it waits on and its CI state from this read, then 'filed as DIPO-n'
- [ ] #6 The PLANNING LANE desk item for a lane stuck 30 minutes stays as it is
- [ ] #7 docs/design/tui-v2/screens/02-floor.txt, 07-plan.txt and spec.md show the BACKLOG line and the filing line with the PR, and the views match them
<!-- AC:END -->
