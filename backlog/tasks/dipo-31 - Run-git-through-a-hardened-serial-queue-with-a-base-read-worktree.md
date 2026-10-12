---
id: DIPO-31
title: Run git through a hardened serial queue with a base read worktree
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 21:26'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-18
  - DIPO-27
references:
  - packages/engine/src/git/
  - packages/engine/test/git/
  - packages/engine/src/features.ts
  - packages/engine/src/index.ts
  - packages/engine/src/office/repository.ts
  - packages/engine/src/platform/repo-files.ts
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

Context: claims, the backlog lane and the story index all use this. The minimum git version 2.38 is checked once per office load (M0 review, DIPO-15), because Done detection uses `git merge-tree --write-tree` (DIPO-58). References: 0010 section 7 (base and remote, worktree root, start point, lock retry, fetch failure), section 2 (`_base` worktree, reads for `run`); 0008 section 2 "Engine git calls" (hardened environment and flags); 0007 section 6 step 4 (fetch only when the remote answers).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

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
    - kind: "automated"
      check: "(unit) version parsing refuses `git version 2.37.1` and accepts `git version 2.38.0` and an Apple Git suffix."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 An office load step (DIPO-27 seam) checks `git --version` is at least 2.38, which `merge-tree --write-tree` needs, and refuses the office with a notice naming the version otherwise.
- [x] #2 Every engine git call runs with `GIT_CONFIG_NOSYSTEM=1`, `-c core.hooksPath=/dev/null -c core.fsmonitor=false`, and `GIT_DIR`/`GIT_COMMON_DIR` from paths recorded by the engine, never read from a worktree.
- [x] #3 The office git queue runs one item at a time; an item may hold several git steps; a test proves two submitted items never interleave.
- [x] #4 The base is `base` from configuration, else `refs/remotes/origin/HEAD`; with neither, operations that need it fail with a clear error.
- [x] #5 The worktree root defaults to `../<repo>.worktrees`, resolves to an absolute path, and is refused when it lies inside the main checkout.
- [x] #6 `ensureBaseWorktree` creates or moves `<root>/_base`, detached at `origin/<base>`, after every fetch that moves the base.
- [x] #7 A held `index.lock` or ref lock is retried three times with backoff, then the step fails; lock files are never deleted.
- [x] #8 A failed fetch makes pickup and planning pushes wait with a retryable error while other work continues.
- [x] #9 The engine never writes the maintainer's main checkout: a test runs every queue operation and compares the main checkout's `git status --porcelain` before and after.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S16 (DIPO-15). Before cutover: built by hand-run agents.

DIPO-31 implementation (2026-10-12):
- packages/engine/src/git/: version check (2.38 minimum), hardened calls (GIT_CONFIG_NOSYSTEM=1, -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.quotePath=off, --no-pager, GIT_TERMINAL_PROMPT=0, LC_ALL=C, inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_CONFIG_PARAMETERS and similar dropped), per-office serial GitQueue, lock retry (3 retries, 100/400/1600 ms on the injected clock, lock files never deleted), base resolution (config base, else refs/remotes/<remote>/HEAD, else git.baseUnknown), worktree root (default ../{repo}.worktrees, absolute, git.rootInsideCheckout when inside the main checkout), ensureBaseWorktree and fetch (moves <root>/_base, detached at <remote>/<base>), fetch gate assertFetched (retryable git.fetchFailed).
- Repository-level calls run as git --bare with cwd and GIT_DIR/GIT_COMMON_DIR the recorded common dir, so no engine call has the main checkout as its work tree. Worktree calls take GIT_DIR from the admin dir found under the recorded common dir and refuse (git.worktreeChanged) when <worktree>/.git no longer points at it.
- features.ts lists engineGit.feature, whose load step git.version checks git --version once per office load and records the office's paths; later stories reach the queue through engineGit.forOffice(office).
- Added refs: packages/engine/src/index.ts (exports the git module), packages/engine/src/office/repository.ts and packages/engine/src/platform/repo-files.ts (AC 2: their read-only discovery and scan git calls now use the same hardening; discovery cannot use recorded paths, it finds them).
- Follow-ups: git.fetchFailed is retryable but not yet in the contract's RETRYABLE_ERROR_CODES; the command that surfaces it (DIPO-48 pickup, DIPO-34 planning push) adds it. OfficeGit takes configuration at office load; office.reloadConfig does not yet call configure(). safe.directory is not overridden (0008 does not ask for it; the daemon runs as the repository owner).
<!-- SECTION:NOTES:END -->
