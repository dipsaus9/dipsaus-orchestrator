---
id: DIPO-474
title: 'File confirmed role additions, edits and removals through the planning lane'
status: Refined
assignee: []
created_date: '2026-11-10 15:05'
updated_date: '2026-11-10 15:05'
labels:
  - 'tier:M'
milestone: m-4
dependencies:
  - DIPO-471
references:
  - packages/contract/src/work.ts
  - packages/engine/src/run/planning-proposals.ts
  - packages/engine/src/run/planning-session.ts
  - packages/engine/src/backlog/lane/lane.ts
  - packages/engine/src/backlog/lane/
  - packages/engine/src/story-store/planning.ts
  - packages/engine/src/roles/
  - docs/decisions/0022-planning-sessions.md
type: feature
ordinal: 447000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want role changes I confirm in a session to be written to the role files through the backlog PR so that I can hire, tune and retire roles without editing files by hand.

The maintainer decided (planning 2026-11-10) that a session may propose adding, editing and removing a role, and that a confirmed change lands through the planning lane's auto-merging backlog PR. Confirming is the review.

Proposals (packages/contract/src/work.ts, PlanningProposal at ~638; checks in packages/engine/src/run/planning-proposals.ts):
- role: a new role with a name, a purpose, optional model and effort, the instructions and a why.
- role-edit: an existing role by name, with only the fields that change, and a why.
- role-remove: an existing role by name, with a why.
The engine checks beyond the schema when it reads the block:
- role: the name is a valid role name, not reserved and not already a role file on the base.
- role-edit and role-remove: the role exists on the base.
- role and role-edit: the file they produce loads with DIPO-471's role-file parser.
- role-remove: no story that is not Done has the role's label. The refusal names those stories.
Refused blocks go back to the session as other proposals' problems do.

Filing:
- A confirmed proposal becomes a lane target that writes or deletes .dipo/roles/<name>.md. The lane drops changes outside backlog/ unless their path is allowed (inLane, packages/engine/src/backlog/lane/lane.ts:280; drop at 796), so role files under .dipo/roles/ are added to what it allows.
- An edit rewrites only the changed fields and keeps the rest of the file.
- At apply time the target checks again: an add whose file now exists, an edit or removal whose role is gone, and a removal whose role a non-Done story now names do not apply. Each is recorded with the reason, as stale story targets are.
- The planning record and the [dipo] lines of the next turn say which roles were added, edited or removed (planning.record, packages/engine/src/run/planning-session.ts:616).

Which session kinds may use these proposals is the roles chat's story. Amend 0022 for the new proposal kinds and 0010 for the lane's role file paths.

```dipo
branch: "DIPO-474/file-confirmed-role-additions-edits"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "checkProposal accepts a valid role, role-edit and role-remove, and refuses a reserved name, an existing name, a missing role and an unparsable result, each with its problem."
    - kind: "automated"
      check: "A role-remove for a role that a Ready story is labelled with is refused, and the problem names that story."
    - kind: "automated"
      check: "Applying role targets on a temporary repository adds, edits and deletes .dipo/roles/<name>.md, and an edit leaves the fields it does not name unchanged."
    - kind: "automated"
      check: "The lane applies a target that writes under .dipo/roles/ and drops one that writes .dipo/office.yaml."
    - kind: "automated"
      check: "A role-remove target whose role a story was labelled with after the confirm does not apply and records the reason."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A role proposal with a valid unused name, a purpose and instructions passes; one with a reserved, invalid or existing name is refused naming the problem.
- [ ] #2 A role-edit or role-remove proposal for a role with no file on the base is refused naming the role.
- [ ] #3 A role or role-edit proposal whose resulting file would not load is refused with the parser's problem.
- [ ] #4 A role-remove proposal for a role that a story not Done is labelled with is refused, naming those stories.
- [ ] #5 A confirmed role proposal lands in the backlog PR as a new .dipo/roles/<name>.md that loads as that role.
- [ ] #6 A confirmed role-edit changes only the fields it names in the role file.
- [ ] #7 A confirmed role-remove deletes the role's file in the backlog PR.
- [ ] #8 The lane applies changes under .dipo/roles/ and still drops changes to other paths outside backlog/.
- [ ] #9 A target whose check fails at apply time does not apply and records why.
- [ ] #10 The next turn's [dipo] lines name each role added, edited or removed.
<!-- AC:END -->
