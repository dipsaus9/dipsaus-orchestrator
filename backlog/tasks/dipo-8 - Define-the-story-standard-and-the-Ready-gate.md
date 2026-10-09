---
id: DIPO-8
title: Define the story standard and the Ready gate
status: To Do
assignee: []
created_date: '2026-10-09 19:46'
labels:
  - architecture
milestone: m-0
dependencies: []
priority: high
type: spike
ordinal: 8000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an ADR defining what a story in an office must contain and exactly what the ready gate checks in code. Cover: outcome, acceptance criteria, dependencies, declared scope, open unknowns, difficulty tier (S, M, L), role (until M4: built-in developer), test-before-merge flag and manual test script, and the lifecycle Draft, Refined, Ready, In Progress, In Review, Done plus Parked. Decide how each field maps to native Backlog.md fields or a convention for non-native ones (coordinate with DIPO-7), and how the lifecycle maps to Backlog.md statuses. Every check must be deterministic so no model is needed to decide readiness. Use the dipsaus-ai story standard as inspiration, not a copy. See docs/decisions/0001, 0002 and 0011.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 ADR docs/decisions/0012-story-standard.md lists every story field, its storage in Backlog.md, and whether it is required
- [ ] #2 ADR lists each ready-gate check as a deterministic rule with its failure message
- [ ] #3 ADR defines the lifecycle states, their transitions, and their mapping to Backlog.md statuses
- [ ] #4 Maintainer approved the decision
<!-- AC:END -->
