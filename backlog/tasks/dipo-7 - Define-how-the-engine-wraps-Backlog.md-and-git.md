---
id: DIPO-7
title: Define how the engine wraps Backlog.md and git
status: To Do
assignee: []
created_date: '2026-10-09 19:17'
labels:
  - architecture
milestone: m-0
dependencies:
  - DIPO-1
priority: high
type: spike
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an ADR defining the engine's integration layer: reading and writing stories only through the Backlog CLI, structured fields that do not fit native Backlog.md fields (park reason, unknowns, test script, review level), parsing robustness, and the deterministic git contract: branch naming <ID>/<slug>, worktree create and teardown, base sync, claim by branch ref, locking for parallel runs. Use the dipsaus-ai backlog-deliver git contract as inspiration, not a copy.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 ADR docs/decisions/0010-backlog-and-git-integration.md records the conventions for non-native fields
- [ ] #2 ADR specifies the git contract and its failure cases
- [ ] #3 Maintainer approved the decision
<!-- AC:END -->
