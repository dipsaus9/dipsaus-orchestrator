---
id: DIPO-319
title: >-
  Decide run transitions in one function and record claims as intents that
  recovery completes
status: Refined
assignee: []
created_date: '2026-10-22 21:00'
updated_date: '2026-10-25 09:55'
labels:
  - 'tier:L'
milestone: m-2
dependencies: []
references:
  - packages/engine/src/run/
  - packages/engine/src/run/outcome-exits.ts
  - packages/engine/src/run/reattach.ts
  - packages/engine/src/run/records.ts
  - packages/engine/src/run/park.ts
  - packages/engine/src/runs/
  - packages/engine/src/worktree/claim.ts
  - packages/engine/src/reconcile/reconcile.ts
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/test/run/
  - packages/engine/test/worktree/
type: chore
ordinal: 304000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: one pure function decides which transition follows from a run's state and an event, and each table has one writer. A claim writes an intent before its first step, so a crash at any point of a claim is finished or undone at start-up and never takes a story out of rotation.

Context:
- **Run state.** Run state is spread over `runs.ended_at`, `end_kind`, `waiting`, `parks`, `run_intents` and `claims`. About ten files under `run/` decide transitions.
- **End-agent copies.** The SQL that ends an agent (end the agent, close the ingest cursor, end the worker host) has three copies: one in `run/outcome-exits.ts` and two in `run/reattach.ts`. They already differ in three ways:
  - step order;
  - whether usage is finalized;
  - whether the worker host is ended.
- **Writers.** Parks are inserted from three directories, `agents` has eight writers and `worker_hosts` five.
- **Claims.** A claim crosses the git worktree, the `claims` row, the remote push and, for a box run, the box. Nothing records its progress, so a crash leaves orphans:
  - between `worktree add` and `insertClaim`, it leaves a worktree that the next pickup skips;
  - between the claim commit and `updateClaim`, it leaves a commit that `rollBackInterruptedSetup` ignores, so the next claim collides.

  Reconcile reports gone worktrees and never prunes them (`worktree/claim.ts`, `reconcile/`).
- DIPO-148, DIPO-149 and DIPO-155 add fix, conflict and resume transitions.

```dipo
branch: "DIPO-319/run-lifecycle-and-claim-intents"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `run/lifecycle.ts` holds a pure function from a run's state and an event to the next state and the writes to make. The existing transitions call it, and a table test lists every state and event pair it allows.
- [ ] #2 The three end-agent copies become one function, with one step order, usage finalized and the worker host ended in every case.
- [ ] #3 `parks` and `worker_hosts` each have one writing module that the others call. A test or lint rule shows that no other module inserts or updates them.
- [ ] #4 A `claim_intents` row (story, path, branch, start commit, box) is written before the worktree is added. It is removed when the claim completes or is rolled back.
- [ ] #5 At start-up, recovery finishes or undoes each step an intent names: it removes a worktree that has no claim, resets a branch whose tip is the claim commit, deletes the box, and frees the story for the next pickup.
- [ ] #6 Tests inject a crash after each claim step. After each, the story is claimable again or its claim is complete, and nothing is left orphaned.
- [ ] #7 `bun run verify` passes.
<!-- AC:END -->

## Comments

<!-- COMMENTS:BEGIN -->
created: 2026-10-25 09:55
---
Folded into DIPO-345 on 2026-10-25 (prune plan): one pure function decides a run's transitions, as a criterion of the one feedback path.
---
<!-- COMMENTS:END -->
