---
id: DIPO-315
title: >-
  Park on worker stream drift, push unpushed In Review stories again, wire
  stopWorkers
status: Refined
assignee: []
created_date: '2026-10-22 21:00'
updated_date: '2026-10-22 21:00'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/src/workers/claude-cli/probe.ts
  - packages/engine/src/ingest/ingestor.ts
  - packages/engine/src/run/caps.ts
  - packages/engine/src/run/verify-commit.ts
  - packages/engine/src/story-pr/records.ts
  - packages/engine/src/story-pr/prs.ts
  - packages/engine/src/run/review-rounds.ts
  - packages/engine/src/run/park.ts
  - packages/engine/src/box/parts.ts
  - packages/engine/src/box/collisions.ts
  - packages/daemon/src/drain.ts
  - packages/daemon/src/foreground.ts
  - packages/contract/src/software.ts
  - packages/engine/test/ingest/
  - packages/engine/test/run/
  - packages/daemon/test/
type: enhancement
ordinal: 300000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an unattended run stays safe when something quietly goes wrong: a Claude stream whose usage dipo cannot read parks the story instead of running past its budget unseen; an In Review story whose push failed is pushed again, and is not reviewed until its head is on the remote; `daemon.stop` with `stopWorkers` either stops the workers or is no longer offered.

Context:
- **Stream drift.** In `workers/claude-cli/interpret.ts`, a worker line that fails its schema is added to `state.problems`, and nothing outside that file reads it. Unknown message types are dropped. `probe.ts` enforces only a minimum version.
  - The caps (`run/caps.ts`) see only the usage that was parsed.
  - Each turn's result replaces the live numbers. So the blind spots are within a turn, and a result whose usage cannot be read.
- **Failed pushes.** A push that fails without a rejection (`run/verify-commit.ts`) only posts `verify.pushFailed`, and nothing pushes again.
  - The PR poll (`story-pr/records.ts`) needs `pushed_at >= ended_at`, and `pendingReviews` (`run/review-rounds.ts`) does not look at `pushed_at`.
  - Pushes in `run/park.ts`, `box/parts.ts` and `box/collisions.ts` do not record `pushed_at`.
- **stopWorkers.** `daemon.stop {stopWorkers: true}` is accepted (`contract/src/software.ts`), but drain (`daemon/src/drain.ts`) gets no stop callback and logs that there are no workers to stop.

```dipo
branch: "DIPO-315/stream-drift-push-retry-stopworkers"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The ingestor counts, per run, the worker lines that fail their schema and the message types it drops. The run parks with a new stream-drift cause, naming the Claude Code version and the count, when either of these happens: the count reaches a threshold (design choice, not a maintainer decision); a result line's usage cannot be read.
- [ ] #2 A turn whose result reports no token usage at all parks with the same cause.
- [ ] #3 dipo records the newest Claude Code version that its recordings and the box image were checked with. A newer version seen at launch posts one `engine.notice` per version.
- [ ] #4 The story-PR poll pushes again, never forced, every claim of a run that ended at In Review whose `pushed_at` is null or earlier than the run's end. It records `pushed_at` when the push reaches the remote, and so does every other story-branch push dipo makes.
- [ ] #5 `pendingReviews` starts no review for such a run until its head is on the remote.
- [ ] #6 `daemon.stop` with `stopWorkers: true` stops every live worker through the run controller before the drain ends. Alternatively, the flag is removed from the contract with a dated note on 0006. Either way, the log line says what happened.
- [ ] #7 Tests cover: the drift park and its threshold; the version notice; the push retry and the held review; stopWorkers.
<!-- AC:END -->
