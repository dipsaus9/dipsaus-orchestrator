---
id: DIPO-8
title: Define the story standard and the Ready gate
status: Done
assignee: []
created_date: '2026-10-09 19:46'
updated_date: '2026-10-10 11:28'
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
- [x] #1 ADR docs/decisions/0012-story-standard.md lists every story field, its storage in Backlog.md, and whether it is required
- [x] #2 ADR lists each ready-gate check as a deterministic rule with its failure message
- [x] #3 ADR defines the lifecycle states, their transitions, and their mapping to Backlog.md statuses
- [x] #4 Maintainer approved the decision
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Draft ADR 0012 written by research agent. First independent review: block (pickup re-check vs R01) plus 7 advisories, all fixed. Second review: pass, 4 advisories, all applied. Waiting for maintainer approval.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
ADR 0012 accepted: 18 story fields with Backlog.md storage, lifecycle with Backlog.md drafts (DRAFT-n promoted at refine), hold by hand (on-hold), Removed state, deterministic Ready gate (R01a-R25), Outcome: line, tier required from M0, test plan field, design stories recognised by role. Amends 0001 (plan creates drafts, on-hold), 0002 (test plan) and the vision (design files are inputs).
<!-- SECTION:FINAL_SUMMARY:END -->
