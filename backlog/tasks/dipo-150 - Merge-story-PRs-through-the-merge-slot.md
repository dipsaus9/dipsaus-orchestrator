---
id: DIPO-150
title: Merge story PRs through the merge slot
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-17 12:52'
labels:
  - 'tier:L'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-144
  - DIPO-147
  - DIPO-149
  - DIPO-133
references:
  - packages/engine/src/merge-slot/
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/src/retention/policy.ts
  - packages/daemon/src/
  - packages/engine/test/merge-slot/
  - packages/engine/test/db/
priority: high
type: feature
ordinal: 139000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: approved story PRs merge through a persisted merge slot with close-out, sync, push, required checks, label and head guards and squash merge, and hand changes and PRs closed on the host are handled as ADR 0019 section 9 says.

Context: implements ADR 0019 section 9 (merging story PRs through the merge slot) and the autorelease guard of section 7 (0016 rules 2 and 12). Today the slot merges backlog PRs only and keeps its occupant and notices in memory, so a daemon restart forgets them (0019 fact 1).

```dipo
branch: "DIPO-150/merge-story-prs-through-the-slot"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(integration, real git and a fake host) an approved story PR goes through close-out, sync, push, checks and squash merge with --match-head-commit"
    - kind: "automated"
      check: "(unit) a daemon restart mid-slot continues with the same occupant and merges once"
    - kind: "automated"
      check: "(unit) autorelease: pending and a hold label keep a PR out of the merge, for story and backlog PRs"
    - kind: "automated"
      check: "(unit) a changed host head raises pr.headChanged and a PR closed on the host parks stopped with cause pr-closed"
    - kind: "automated"
      check: "(migration) merge_slot exists with retention tier P"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A story PR enters the slot when its merge gate is approved, the verdict or an override holds for its head, its required checks were green and no hold label is on it; story and backlog PRs share the one-PR-at-a-time slot, first come first served by eligibility time
- [ ] #2 The slot runs as office git queue items in the story worktree: close-out commit, merge of the base unless contained (a conflict leaves the slot as a conflict hand-off), one push never forced, required checks (red leaves the slot as a CI fix round), label guard and host head equal to the pushed head, then squash merge with --match-head-commit and the PR title as subject
- [ ] #3 A host refusal because the base moved goes back to the sync step at most 3 times per stay, then parks conflict with cause slot-refused
- [ ] #4 A merge_slot table (occupant, phase, pushed head, attempt count; retention tier P) keeps the slot across a daemon restart, its row deleted when the PR merges or leaves the slot, and every step is idempotent when run again
- [ ] #5 A PR labelled autorelease: pending is never merged by the engine for any PR kind, checked in code before entry and right before the host merge; a label in mergeSlot.holdLabels holds the PR until it is gone; backlog PRs gain the persistence and the label guard
- [ ] #6 A host head that differs from the pushed head keeps the story out of the slot with a pr.headChanged notice naming both heads, and a story PR closed on the host without a merge parks stopped with cause pr-closed and detail PR #n was closed on the host
<!-- AC:END -->
