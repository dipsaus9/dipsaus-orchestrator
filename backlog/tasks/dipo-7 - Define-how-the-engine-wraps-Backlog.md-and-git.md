---
id: DIPO-7
title: Define how the engine wraps Backlog.md and git
status: Done
assignee: []
created_date: '2026-10-09 19:17'
updated_date: '2026-10-10 17:38'
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
- [x] #1 ADR docs/decisions/0010-backlog-and-git-integration.md records the conventions for non-native fields
- [x] #2 ADR specifies the git contract and its failure cases
- [x] #3 Maintainer approved the decision
- [x] #4 ADR defines how a worktree gets gitignored files such as .env that exist in the main checkout
- [x] #5 ADR defines port allocation so parallel worktrees can run the product at the same time
- [x] #6 ADR defines the per-office worktree setup contract: post-create steps, files to link or copy, environment overrides such as a port offset (research idea 7)
- [x] #7 ADR defines an optional declared component map in the repository (components, file globs, dependencies) usable for scope and collision checks (research idea 18)
- [x] #8 Anything the engine writes into the repository or worktrees (setup steps, links, component map scaffolding) is additive and removable (research idea 12)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Scope addition (decision 0011): worktrees lack gitignored files such as .env that exist in the main checkout; decide how a worktree gets them. Decide port allocation for parallel worktrees. Product run knowledge (install, start, test scripts) is scanned and stored in the local database with a rescan command.

Draft ADR 0010 by research agent. Reviews: block (backlog edits never reach protected main), block (lane races, claim release), block (release window); all fixed with journal-first and a serial git queue. Contains Amends 0012 and 0002 (needs maintainer approval). Waiting for maintainer approval.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
ADR 0010 accepted: all backlog writes go through PRs (story lane a, auto-merged backlog-only lane b), YAML field block, branch ref as claim, worktrees at ../<repo>.worktrees, env files copied, ports stride 10 x 20 slots, StoryKey only in the state database, base sync only on conflict or for tier L / test-before-merge stories, branches and worktrees deleted after merge. Amends 0012 (transition lanes, leaving a claim), 0002 (backlog PR auto-merge) and 0005 (identity fallback).
<!-- SECTION:FINAL_SUMMARY:END -->
