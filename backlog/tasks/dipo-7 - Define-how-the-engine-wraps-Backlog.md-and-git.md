---
id: DIPO-7
title: Define how the engine wraps Backlog.md and git
status: To Do
assignee: []
created_date: '2026-10-09 19:17'
updated_date: '2026-10-10 10:18'
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
Outcome: an ADR defining the engine's integration layer: reading and writing stories only through the Backlog CLI, structured fields that do not fit native Backlog.md fields (park reason, unknowns, tier, test-before-merge flag, test script; field list owned by DIPO-8), parsing robustness, and the deterministic git contract: branch naming <ID>/<slug>, worktree create and teardown, base sync, claim by branch ref, locking for parallel runs. Use the dipsaus-ai backlog-deliver git contract as inspiration, not a copy.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 ADR docs/decisions/0010-backlog-and-git-integration.md records the conventions for non-native fields
- [ ] #2 ADR specifies the git contract and its failure cases
- [ ] #3 Maintainer approved the decision
- [ ] #4 ADR defines how a worktree gets gitignored files such as .env that exist in the main checkout
- [ ] #5 ADR defines port allocation so parallel worktrees can run the product at the same time
- [ ] #6 ADR defines the per-office worktree setup contract: post-create steps, files to link or copy, environment overrides such as a port offset (research idea 7)
- [ ] #7 ADR defines an optional declared component map in the repository (components, file globs, dependencies) usable for scope and collision checks (research idea 18)
- [ ] #8 Anything the engine writes into the repository or worktrees (setup steps, links, component map scaffolding) is additive and removable (research idea 12)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Scope addition (decision 0011): worktrees lack gitignored files such as .env that exist in the main checkout; decide how a worktree gets them. Decide port allocation for parallel worktrees. Product run knowledge (install, start, test scripts) is scanned and stored in the local database with a rescan command.
<!-- SECTION:NOTES:END -->
