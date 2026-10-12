---
id: DIPO-38
title: Claim a story with its branch and worktree
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 21:47'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-29
  - DIPO-31
  - DIPO-32
references:
  - packages/engine/src/worktree/claim.ts
  - packages/engine/src/worktree/
  - packages/engine/src/db/migrations/
  - packages/engine/test/worktree/
  - packages/engine/src/platform/disk.ts
  - packages/engine/src/git/
  - packages/engine/test/git/
documentation:
  - docs/decisions/0007-state-database.md
  - docs/decisions/0010-backlog-and-git-integration.md
priority: high
type: feature
ordinal: 38000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine claims a story by creating its frozen branch and a locked worktree at `<root>/<ID>` from `origin/<base>` in one git-queue item, commits `<ID>: status In Progress` in the worktree through the Backlog CLI, pushes the branch, and records the claim.

Context: setup after the claim is DIPO-39. Reusing a released branch is included because a parked story's branch is kept. The free-disk check before a claim was added in the M0 review (DIPO-15); its 2 GB floor is a constant. The `claims` table here is what the backlog PR check (DIPO-35) reads for live claims. References: 0010 section 7 (start point, claim checks, lock, failure cases), section 2 (lane a, push after the claim commit, only the story's task file under `backlog/`), section 2a (released branch reuse with `origin/<base>` merge); 0007 section 4 (`claims`, `released_branches`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-38/claim-story-its-branch-worktree"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(integration) claim in a temp repo with a bare remote; branch, locked worktree, one claim commit and a remote ref exist."
    - kind: "automated"
      check: "(integration) parallel claims of one branch; one wins, the other skips cleanly."
    - kind: "automated"
      check: "(integration) unknown existing ref gives `collision`; released branch is reused and merged with the base."
    - kind: "automated"
      check: "(unit) with a fake disk probe reporting 1 GB free the claim skips as `notRunnable` and creates nothing."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A migration adds `claims` and `released_branches`.
- [ ] #2 Before the claim the engine checks free space on the worktree root's filesystem through `platform/disk.ts` and skips the story as `notRunnable` with a notice naming the free space when less than 2 GB is free.
- [ ] #3 The claim checks the exact local ref is absent, `git ls-remote --heads origin <branch>` is empty and the worktree path does not exist, then runs `git worktree add -b <branch> <path> origin/<base>` and `git worktree lock --reason "dipo <run-id>"`.
- [ ] #4 The start SHA is recorded; a lost `cannot lock ref` race is a skip with nothing to clean.
- [ ] #5 The claim commit changes only the story's task file and is pushed without force.
- [ ] #6 A ref released for the same StoryKey is reused with `git worktree add <path> <branch>` and `origin/<base>` is merged into it before the claim commit; a code conflict is aborted and recorded as first feedback for the worker.
- [ ] #7 A ref tracked for another StoryKey or unknown to the engine is a `collision` skip with a notice and is never deleted; an existing worktree path is a skip with a notice and is not touched.
- [ ] #8 The pickup re-check and the claim run in the same git-queue item, so a lane-b operation lands either before (skip) or after (refused by the live-claim check).
- [ ] #9 At claim the engine records a snapshot of the story worktree's admin dir `commondir` and `gitdir` and its `.git` pointer (0008 section 2); the git layer refuses every later engine git call in that worktree when one differs, and the run parks the story `scope-violation` with no more git in that worktree. A test tampers with each of `commondir`, `gitdir` and the `.git` pointer and sees the refusal; DIPO-31's pointer check alone covers only `_base`.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S22 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
