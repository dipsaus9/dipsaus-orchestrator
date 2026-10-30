---
id: DIPO-399
title: Make a story PR that changes an ADR wait for the maintainer
status: Refined
assignee: []
created_date: '2026-10-30 21:55'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/merge/stories.ts
  - packages/engine/src/merge/gates.ts
  - docs/decisions/0002-review-and-testing.md
priority: high
type: bug
ordinal: 377000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a story PR that changes a file in docs/decisions/ waits for the maintainer at the merge gate, so no ADR change merges without the maintainer's approval (CLAUDE.md).

Gap G15, 2026-10-30: dipo ran DIPO-397, whose PR #482 added `run.ended` to 0005's event catalogue, and merged it by rule after an approved review. The maintainer had approved the idea and was to approve the wording at merge, but the merge gate (0002 section 7) has no reason to wait for a change under docs/decisions/. The added line matched what was approved, but the rule was not kept. CLAUDE.md: decisions that change docs/decisions/ need the maintainer's explicit approval. 0002, 0003, 0001.

```dipo
branch: "DIPO-399/adr-change-waits"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a story PR whose diff touches docs/decisions/ gets a merge gate that waits for the maintainer; one that does not is decided by rule"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The merge gate waits for the maintainer when the PR's diff against its base adds, changes, renames or deletes any file under docs/decisions/, read fresh from the PR at each gate decision; the gate text names the ADR files
- [ ] #2 What the gate caught before still holds, each with a test: the existing waiting reasons and the by-rule path for a PR without ADR changes
- [ ] #3 Bypass forms are tested: an ADR change pushed after the review approved (a fix round or a later head), a rename into or out of docs/decisions/, a change only to an ADR's Replaced list, and a path with another case (Docs/Decisions/) on the case-insensitive file system
- [ ] #4 Fail-closed against the real path: when the PR's changed files cannot be read, the gate waits for the maintainer instead of opening by rule
- [ ] #5 0002's list of reasons the gate waits for the maintainer names the ADR change, with one Replaced line; the maintainer approves the wording
<!-- AC:END -->
