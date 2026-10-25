---
id: DIPO-340
title: Record the follow-up architecture decisions in the ADRs
status: Done
assignee: []
created_date: '2026-10-24 18:58'
updated_date: '2026-10-24 19:00'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - docs/decisions/
  - docs/concepts.md
  - docs/research/2026-10-24-simplification-audit.md
type: docs
ordinal: 320000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the ADRs record the follow-up decisions of 2026-10-24 (light CI for backlog-only PRs, verify by dipo in the box with a box-local git repository, the reviewer in its own box, the createEngine factory, the StoryStore seam) and how dipo is built during the prune.

The maintainer decided these after reviewing the target architecture deck. Documentation only; the prune plan follows.

```dipo
branch: "DIPO-340/follow-up-adr-decisions"
unknowns: []
test_plan:
  not_applicable: "Documentation only; no code or behaviour changes in this story."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 0016 gives backlog-only PRs a light CI path with ci-ok still required
- [x] #2 0002 and 0008 say dipo runs verify in the box at done, with a box-local git repository, and CI is the final gate
- [x] #3 0002 and 0008 put the reviewer in its own read-only box, and no session has hooks
- [x] #4 0005 describes the daemon and the engine behind one createEngine factory, and 0010 describes the StoryStore seam
- [x] #5 0003 records how dipo is built during the prune and the plan-first experiment under Later
<!-- AC:END -->
