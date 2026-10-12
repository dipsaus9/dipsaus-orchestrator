---
id: DIPO-58
title: Detect Done and tear down worktrees and branches
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 09:37'
labels:
  - 'tier:M'
  - after-cutover
milestone: m-0
dependencies:
  - DIPO-35
  - DIPO-38
  - DIPO-39
  - DIPO-46
  - DIPO-47
references:
  - packages/engine/src/worktree/teardown.ts
  - packages/engine/src/worktree/
  - packages/engine/test/worktree/
  - packages/engine/src/platform/host.ts
documentation:
  - docs/decisions/0007-state-database.md
  - docs/decisions/0010-backlog-and-git-integration.md
priority: medium
type: feature
ordinal: 58000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: after a story's PR merges, the engine detects Done from the host's PR state or from `git merge-tree`, closes the claim and run, removes the worktree, frees the slot, and deletes the local and remote branch.

Context: the host is reached through `platform/host.ts` (DIPO-35), polled at the office's `polling.prStateSeconds` (DIPO-26); `worker_notes` and `context_packs` come from DIPO-47 and DIPO-46 (M0 review, DIPO-15). References: 0010 section 7 ("Merge and Done", "Teardown", dirty worktree failure case), open question 8; 0007 section 7 (tier T rows deleted at teardown).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

Built after cutover: dipo delivers this story itself (M0 breakdown decision D6, DIPO-15).

```dipo
branch: "DIPO-58/detect-done-tear-down-worktrees-branches"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(integration) squash-merge the branch on the bare remote; detection and teardown follow; a dirty worktree is kept with a notice."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 PR state is read through `platform/host.ts` every `polling.prStateSeconds` from office configuration.
- [ ] #2 Done is detected from the host PR state, or when `git merge-tree --write-tree origin/<base> <branch>` returns the tree of `origin/<base>`, never by ancestry.
- [ ] #3 Teardown unlocks and runs `git worktree remove` without `--force`; a dirty or locked worktree keeps everything and raises a notice listing the files.
- [ ] #4 The local branch is deleted with `-D` only after Done is detected, then `git push origin --delete <branch>`; a missing remote branch is accepted.
- [ ] #5 The slot is freed and `worker_notes` and `context_packs` for the worktree are deleted.
- [ ] #6 Parked stories keep worktree, branch and slot.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S42 (DIPO-15). After cutover: built by dipo itself, not by a hand-run agent.
<!-- SECTION:NOTES:END -->
