---
id: DIPO-31
title: Run git through a hardened serial queue with a base read worktree
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-11 18:49'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-18
  - DIPO-27
references:
  - packages/engine/src/git/
  - packages/engine/test/git/
documentation:
  - docs/decisions/0007-state-database.md
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0010-backlog-and-git-integration.md
priority: high
type: feature
ordinal: 31000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: each office runs its git operations one at a time through a queue, every engine git call is hardened against planted config and hooks, and the engine keeps a detached `_base` worktree at `origin/<base>` for reads.

Context: claims, the backlog lane and the story index all use this. References: 0010 section 7 (base and remote, worktree root, start point, lock retry, fetch failure), section 2 (`_base` worktree, reads for `run`); 0008 section 2 "Engine git calls" (hardened environment and flags); 0007 section 6 step 4 (fetch only when the remote answers).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

```dipo
branch: "DIPO-31/run-git-through-hardened-serial-queue"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(integration) planted `core.hooksPath` and `core.fsmonitor` in a temp repo do not run during engine git calls."
    - kind: "automated"
      check: "(integration) `_base` follows `origin/main` after a push to the bare remote."
    - kind: "automated"
      check: "(unit) queue ordering and lock retry with a fake runner."
    - kind: "automated"
      check: "(integration) root inside the main checkout is refused."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every engine git call runs with `GIT_CONFIG_NOSYSTEM=1`, `-c core.hooksPath=/dev/null -c core.fsmonitor=false`, and `GIT_DIR`/`GIT_COMMON_DIR` from paths recorded by the engine, never read from a worktree.
- [ ] #2 The office git queue runs one item at a time; an item may hold several git steps; a test proves two submitted items never interleave.
- [ ] #3 The base is `base` from configuration, else `refs/remotes/origin/HEAD`; with neither, operations that need it fail with a clear error.
- [ ] #4 The worktree root defaults to `../<repo>.worktrees`, resolves to an absolute path, and is refused when it lies inside the main checkout.
- [ ] #5 `ensureBaseWorktree` creates or moves `<root>/_base`, detached at `origin/<base>`, after every fetch that moves the base.
- [ ] #6 A held `index.lock` or ref lock is retried three times with backoff, then the step fails; lock files are never deleted.
- [ ] #7 A failed fetch makes pickup and planning pushes wait with a retryable error while other work continues.
- [ ] #8 The engine never writes the maintainer's main checkout: a test runs every queue operation and compares the main checkout's `git status --porcelain` before and after.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S16 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
