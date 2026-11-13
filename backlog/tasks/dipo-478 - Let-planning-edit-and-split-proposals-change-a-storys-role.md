---
id: DIPO-478
title: Let planning edit and split proposals change a story's role
status: In Review
assignee: []
created_date: '2026-11-10 15:18'
updated_date: '2026-11-13 13:26'
labels:
  - 'tier:M'
milestone: m-4
dependencies:
  - DIPO-471
  - DIPO-476
references:
  - packages/contract/src/work.ts
  - packages/engine/src/run/planning-proposals.ts
  - packages/engine/src/run/planning-session.ts
  - packages/engine/src/story-store/planning.ts
  - packages/engine/src/backlog/lane/stories.ts
  - packages/engine/src/story-store/fields/labels.ts
  - docs/decisions/0022-planning-sessions.md
type: feature
ordinal: 451000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want a planning edit or split to be able to move an open story to another role so that after I add a role I can hand it the stories it should run, and the Ready gate checks each moved story again.

An edit proposal today replaces only the title, Story line, context, criteria and references (editShape, packages/contract/src/work.ts:606-618). The revise target and its apply have the same five fields (ReviseTarget, packages/engine/src/story-store/planning.ts:124-135; revisedOf and revisionCalls, packages/engine/src/backlog/lane/stories.ts:241-288). No label can change. The maintainer decided (planning 2026-11-10) that edit and split proposals can change the role label, and that a Ready story whose role changes goes back to Refined.

- Contract: editShape gains an optional role field with the same schema as the role field a new story proposal carries (DIPO-476). A split's edit gets it through PlanningEditFields (work.ts:635). An edit that gives only a role passes editChecks (work.ts:622).
- Confirm: the session refuses an edit or split whose role is not in the office's roster (DIPO-471), using the check a new story's role uses. The message names the role.
- Lane: ReviseTarget gains role. reviseKind's apply (stories.ts:290) compares the role with the story's current role: label (readLabels, packages/engine/src/story-store/fields/labels.ts:30). When they differ, it removes the old role: label and adds the new one with task edit --remove-label and --add-label. Replacing the labels is refused by the runner (packages/engine/src/backlog/runner.ts:405). The read-back check (stories.ts:328) covers the role too.
- Status: when the role changes and the story is Ready, the same revision sets it to Refined, so the daemon's Ready gate decides it again under the new role, as it does any Refined story. A Refined or Parked story keeps its status. An edit that names the role the story already has changes nothing and moves nothing.
- A story with a live claim is refused as any edit is today (planning lane, packages/engine/src/story-store/planning.ts:171-172).

Amend 0022 to say an edit or split can change the role and what that does to a Ready story.

```dipo
branch: "DIPO-478/let-planning-edit-split-proposals-change"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "checkProposal accepts an edit with only a role and a split whose edit has only a role, and refuses an edit with no field at all."
    - kind: "automated"
      check: "Confirming an edit whose role is not in the roster throws the refusal naming the role and journals no change."
    - kind: "automated"
      check: "Applying a revise target with a new role on a temporary backlog replaces role:developer with the new role label and leaves the other labels in place."
    - kind: "automated"
      check: "Applying a role change to a Ready task leaves it Refined; to a Refined task and a Parked task leaves the status as it was."
    - kind: "automated"
      check: "Applying a revise target whose role equals the task's current role runs no task edit call."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 An edit proposal with only a role field passes the proposal schema, and so does a split whose edit has only a role field.
- [x] #2 Confirming an edit or split whose role is not in the office's roster is refused with a message naming the role, and nothing is journaled.
- [x] #3 A confirmed edit with a new role leaves the story with exactly one role label, the new one, once the backlog PR's change is applied.
- [x] #4 A confirmed role change on a Ready story leaves it Refined; on a Refined or Parked story the status is unchanged.
- [x] #5 A confirmed edit naming the role the story already has changes no label and no status.
- [x] #6 An edit that changes the role together with other fields applies all of them in one revision.
- [x] #7 Decision 0022 describes the role field of edit and split proposals and the move of a Ready story to Refined.
<!-- AC:END -->
