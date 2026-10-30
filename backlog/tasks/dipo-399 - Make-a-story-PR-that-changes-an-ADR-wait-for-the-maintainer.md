---
id: DIPO-399
title: Make a story PR that changes an ADR wait for the maintainer
status: Refined
assignee: []
created_date: '2026-10-30 21:55'
updated_date: '2026-10-30 21:56'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/merge/stories.ts
  - packages/engine/src/merge/gates.ts
  - packages/engine/src/merge/story-git.ts
  - packages/engine/src/backlog/pr/merge.ts
  - packages/engine/src/backlog/pr/merge-git.ts
  - docs/decisions/0002-review-and-testing.md
priority: high
type: bug
ordinal: 377000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a PR that dipo merges, a story PR or a backlog-only PR, waits for the maintainer when it changes anything under docs/decisions/, so no ADR change merges without the maintainer's approval (CLAUDE.md).

Gap G15, 2026-10-30: dipo ran DIPO-397, whose PR #482 added `run.ended` to 0005's event catalogue, and merged it by rule after an approved review. The maintainer had approved the idea and was to approve the wording at merge, but neither the story PR's merge gate (merge/stories.ts, gates.ts `MergeWait`) nor the backlog PR's merge (backlog/pr/merge.ts `#stopOf`) has a reason to wait for a change under docs/decisions/. The release path already reads a PR's changed files fresh at each decision (`StoryMergeGit.releasePaths` / `releasePathsOnBase` in merge/story-git.ts, failing closed with a releaseUnknown notice); reuse it. CLAUDE.md itself is out of scope here. 0002, 0003, 0001.

```dipo
branch: "DIPO-399/adr-change-waits"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a story PR and a backlog PR whose diff touches docs/decisions/ wait for the maintainer; ones that do not are decided by rule"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A story PR's merge gate waits for the maintainer (a new MergeWait kind naming the ADR paths, approvable with dipo approve) when the diff from the merge base to the head, read fresh at each gate decision with --no-renames, adds, changes or deletes any file under docs/decisions/ (subfolders and non-.md files included); the fact also reaches waitsForGreen and heldBack as the release path does
- [ ] #2 A backlog-only PR (backlog/pr/merge.ts) is stopped the same way when it touches docs/decisions/, and waits for the maintainer instead of merging by rule
- [ ] #3 What the gates caught before still holds, each with a test: the existing waiting reasons, the release path, and the by-rule path for a PR without ADR changes
- [ ] #4 Bypass forms are tested against real git: an ADR change pushed in a later head after the review approved or after a by-rule decision, a rename into or out of docs/decisions/, a change only to an ADR's Replaced list, a subfolder or non-.md file, and Docs/Decisions/ in another case on the case-insensitive file system
- [ ] #5 Fail-closed against real git: when the changed files cannot be read, the gate waits for the maintainer with a named notice (the releasePathUnknown notice or a sibling) instead of opening by rule
- [ ] #6 0002's list of reasons the gate waits for the maintainer names the ADR change, with one Replaced line; the maintainer approves the wording
<!-- AC:END -->
