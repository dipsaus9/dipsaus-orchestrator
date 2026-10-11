---
id: DIPO-38
title: Claim a story with its branch and worktree
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-11 18:49'
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

Context: setup after the claim is DIPO-39. Reusing a released branch is included because a parked story's branch is kept. References: 0010 section 7 (start point, claim checks, lock, failure cases), section 2 (lane a, push after the claim commit, only the story's task file under `backlog/`), section 2a (released branch reuse with `origin/<base>` merge); 0007 section 4 (`claims`, `released_branches`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

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
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A migration adds `claims` and `released_branches`.
- [ ] #2 The claim checks the exact local ref is absent, `git ls-remote --heads origin <branch>` is empty and the worktree path does not exist, then runs `git worktree add -b <branch> <path> origin/<base>` and `git worktree lock --reason "dipo <run-id>"`.
- [ ] #3 The start SHA is recorded; a lost `cannot lock ref` race is a skip with nothing to clean.
- [ ] #4 The claim commit changes only the story's task file and is pushed without force.
- [ ] #5 A ref released for the same StoryKey is reused with `git worktree add <path> <branch>` and `origin/<base>` is merged into it before the claim commit; a code conflict is aborted and recorded as first feedback for the worker.
- [ ] #6 A ref tracked for another StoryKey or unknown to the engine is a `collision` skip with a notice and is never deleted; an existing worktree path is a skip with a notice and is not touched.
- [ ] #7 The pickup re-check and the claim run in the same git-queue item, so a lane-b operation lands either before (skip) or after (refused by the live-claim check).
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S22 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
