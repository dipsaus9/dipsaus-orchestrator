---
id: DIPO-348
title: Make every commit and push through one git module
status: Refined
assignee: []
created_date: '2026-10-25 09:51'
labels:
  - 'tier:L'
  - 'slice:prune'
  - 'track:1'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/git/
  - packages/engine/src/worktree/
  - packages/engine/src/box/
  - packages/engine/src/backlog/
  - packages/engine/src/merge-slot/
  - packages/engine/src/run/
  - packages/engine/src/platform/repo-files.ts
  - packages/engine/src/office/repository.ts
priority: high
type: chore
ordinal: 328000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: every commit, push and branch delete dipo makes goes through one git module with hardened calls, a claim is the branch ref made with git update-ref plus the claims row, and the seven commit paths and the two story-git.ts files are merged into it.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. 0010 section 5 and the audit's proposal 8.

```dipo
branch: "DIPO-348/one-git-module"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(git, temp repos) two claims of one branch race and exactly one wins"
    - kind: "automated"
      check: "(lint) no file outside the git module spawns git"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 One git module makes every commit, push and branch delete; the commit paths of claim, parts, collisions, the backlog lane, the merge slot, a reused branch and backlog PR adoption call it
- [ ] #2 A claim creates the branch with git update-ref refs/heads/<branch> <start> and an empty old value after an empty ls-remote, and a lost race is a skip
- [ ] #3 Every git call runs hardened, including the ones in platform/repo-files.ts and office/repository.ts that spawned git directly
- [ ] #4 Pushes are never forced, and a remote branch delete carries a lease on the tip dipo pushed
<!-- AC:END -->
