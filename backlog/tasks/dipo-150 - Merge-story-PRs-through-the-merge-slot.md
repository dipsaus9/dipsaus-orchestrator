---
id: DIPO-150
title: >-
  Merge story PRs through the merge slot, with the maintainer's approve, reject
  or override
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-23 06:25'
labels:
  - 'tier:L'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-144
  - DIPO-147
  - DIPO-149
  - DIPO-133
  - DIPO-284
  - DIPO-290
  - DIPO-292
  - DIPO-294
  - DIPO-295
  - DIPO-299
  - DIPO-152
  - DIPO-296
  - DIPO-140
  - DIPO-219
  - DIPO-148
  - DIPO-251
  - DIPO-281
  - DIPO-302
references:
  - docs/decisions/
  - packages/cli/src/
  - packages/daemon/src/
  - packages/engine/src/commands/
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/src/features.ts
  - packages/engine/src/gate/
  - packages/engine/src/merge-slot/
  - packages/engine/src/reads/hello.ts
  - packages/engine/src/retention/policy.ts
  - packages/engine/src/run/
  - packages/engine/src/worktree/done.ts
  - packages/engine/test/commands/
  - packages/engine/test/db/
  - packages/engine/test/merge-slot/
  - packages/engine/test/run/
  - packages/engine/test/worktree/
priority: high
type: feature
ordinal: 139000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: story PRs whose review verdict holds and whose required checks are green merge through a persisted merge slot as ADR 0019 section 9 says, behind merge gates decided as ADR 0019 section 11 says: dipo approve and dipo reject decide a gate that waits for the maintainer, a review-blocked park opens an override gate whose approval needs a note, and a hand merge closes the gate through the Done poll.

Context: implements ADR 0019 section 9 (merging story PRs through the merge slot) and the autorelease guard of section 7 (0016 rules 2 and 12). Today the slot merges backlog PRs only and keeps its occupant and notices in memory, so a daemon restart forgets them (0019 fact 1).

Since 2026-10-22 strict is off on main (0016 amendment): the slot brings a branch up to date only when the host reports a conflict.

From DIPO-151: implements ADR 0019 section 11 (when a merge waits for the maintainer, the gate, approve, reject, hand merge, approving past a blocked review, CLI; spike answer 3) and the capability flag of section 15; the override value of parks.resolved_how is listed in 0020 section 15. gate.approve and gate.reject are provisional today (0019 fact 8).

```dipo
branch: "DIPO-150/merge-story-prs"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(integration, real git and a fake host) an approved head plus a clean base merge the merge slot made and a task-file commit carries the approval to the new head with no review round"
    - kind: "automated"
      check: "(integration, real git and a fake host) a story PR with an approved verdict and green checks goes through close-out, sync, push, checks and squash merge with --match-head-commit"
    - kind: "automated"
      check: "(unit) a daemon restart mid-slot continues with the same occupant and merges once"
    - kind: "automated"
      check: "(unit) autorelease: pending and a hold label keep a PR out of the merge, for story and backlog PRs"
    - kind: "automated"
      check: "(unit) a changed host head raises pr.headChanged and a PR closed on the host parks stopped with cause pr-closed"
    - kind: "automated"
      check: "(migration) merge_slot exists with retention tier P"
    - kind: "automated"
      check: "(unit) each waiting condition of section 11 makes the gate wait, and none decides it by rule"
    - kind: "automated"
      check: "(unit) a story PR with an approved verdict and green checks stays out of the merge slot until its merge gate is approved"
    - kind: "automated"
      check: "(unit) override: no note answers gate.noteRequired, a note resolves the park as override and returns the story to In Review"
    - kind: "automated"
      check: "(unit) gate.approve on an autorelease: pending PR answers gate.handMergeOnly and on a rule gate answers gate.notWaitingOnMaintainer"
    - kind: "automated"
      check: "(unit, cli) dipo approve and dipo reject send the open gate id and exit 1 when nothing waits"
    - kind: "automated"
      check: "(unit) the Done poll decides an open merge gate after a hand merge"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A story PR enters the slot when the review verdict, or a maintainer override, holds for its head, its required checks were green on that head and no hold label is on it; story and backlog PRs share the one-PR-at-a-time slot, first come first served by eligibility time (DIPO-151 later puts the merge gate in front of this entry)
- [ ] #2 The slot runs as office git queue items in the story worktree: close-out commit, merge of the base unless contained (a conflict leaves the slot as a conflict hand-off), one push never forced, required checks (red leaves the slot as a CI fix round), label guard and host head equal to the pushed head, then squash merge with --match-head-commit and the PR title as subject
- [ ] #3 A host refusal because the base moved goes back to the sync step at most 3 times per stay, then parks conflict with cause slot-refused
- [ ] #4 A merge_slot table (occupant, phase, pushed head, attempt count; retention tier P) keeps the slot across a daemon restart, its row deleted when the PR merges or leaves the slot, and every step is idempotent when run again
- [ ] #5 A PR labelled autorelease: pending is never merged by the engine for any PR kind, checked in code before entry and right before the host merge; a label in mergeSlot.holdLabels holds the PR until it is gone; backlog PRs gain the persistence and the label guard
- [ ] #6 A host head that differs from the pushed head keeps the story out of the slot with a pr.headChanged notice naming both heads, and a story PR closed on the host without a merge parks stopped with cause pr-closed and detail PR #n was closed on the host
- [ ] #7 The merge slot records each clean base merge it makes, so a review approval of the head before that merge carries over to the merged head when only that merge and task-file commits lie between them, recorded as carried to the new head with no new review round (0019 section 6)
- [ ] #8 (from DIPO-151) A merge gate (gate.reached, kind merge) opens when the review approved and the required checks are green on the head, and from this story a story PR enters the merge slot of DIPO-150 only once that gate is approved, in front of the slot's own entry conditions; the gate waits for the maintainer when mergeSlot.autoMerge is false, the story is flagged test-before-merge, a criterion is marked maintainer, the story passed by override, or a hold label is on the PR, and is otherwise decided approved by rule and recorded
- [ ] #9 (from DIPO-151) The gate's code-built summary names why it waits; for a flagged story it lists the manual test-plan entries and the worktree path, and the phase is test for a flagged story, merge otherwise
- [ ] #10 (from DIPO-151) gate.approve decides approved by maintainer and the PR enters the slot; gate.reject (confirmation and note required) decides rejected and starts a fix round with the note; both answer gate.notWaitingOnMaintainer for a gate decided by rule, and gate.approve answers gate.handMergeOnly for a PR labelled autorelease: pending
- [ ] #11 (from DIPO-151) A review-blocked park opens a merge gate summarising the blocking findings; gate.approve on it without a note answers gate.noteRequired, and with a note records a maintainer override, marks the verdict overridden, resolves the park with resolved_how override (added to the parks check by migration) and returns the story to In Review with no session
- [ ] #12 (from DIPO-151) dipo approve <ID> [--note <text>] and dipo reject <ID> --note <text> (with confirmation) send the story's open maintainer gate read from story.detail, and with none print that nothing waits and exit 1; capability flag review in reads/hello.ts lists gate.approve and gate.reject
- [ ] #13 (from DIPO-151) A hand merge detected by the Done poll decides the open gate approved by maintainer with the note merged on the host in the same transaction
- [ ] #14 Stages of a run after its start (story PR open, required checks, reviewer model and adapter, the merge) read the run's recorded configuration snapshot, not the configuration in force, since a base change now reloads it on the poll (DIPO-303 review, 2026-10-22)
- [ ] #15 (from DIPO-154) The merge slot close-out commit calls writeCloseOutSummary (packages/engine/src/merge-slot/close-out.ts) so the task file gets the final summary
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
From DIPO-299 (2026-10-22): the merge gate reads noCiRan() and does not wait on the required checks of a box run's head that got no CI; the review decides there.

2026-10-22: combined from DIPO-151 (maintainer, M1 speed-up)

2026-10-22: dropped the dependency on DIPO-159 (which now holds DIPO-289) to break a dependency cycle left by the M1 combine; that story now comes after this one.
<!-- SECTION:NOTES:END -->
