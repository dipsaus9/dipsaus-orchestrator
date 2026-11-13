---
id: DIPO-493
title: A planning edit or split can set a story's dependencies
status: Refined
assignee: []
created_date: '2026-11-12 13:49'
updated_date: '2026-11-13 09:29'
labels:
  - 'tier:M'
milestone: m-3
dependencies: []
references:
  - packages/contract/src/work.ts
  - packages/engine/src/story-store/planning.ts
  - packages/engine/src/backlog/lane/stories.ts
  - packages/engine/src/run/planning-session.ts
  - packages/engine/src/run/planning-proposals.ts
  - packages/engine/src/gate/rules.ts
  - packages/engine/src/prompts/contract/planning-box.md
  - packages/engine/src/prompts/task/planning.md
  - packages/engine/test/run/planning-world.ts
  - packages/engine/test/run/planning-proposals.test.ts
  - docs/decisions/0022-planning-sessions.md
priority: high
type: feature
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want a planning session's edit and split proposals to set an existing story's dependencies, so that I can order stories in the conversation and never have to edit the backlog by hand for it.

M3 (0022). Refined from draft-12 (a planning session's aside in run run_01M77ZKFFC382ED1VEHGMQQ34Y, audited by dipo and accepted by the maintainer). During the M4 planning on 2026-11-12 the session told the maintainer to add M4's dependencies by hand; the maintainer: "I dont want to do that myself. The planning session should be able to do something with it".

Found (the draft's evidence, checked on main): an edit proposal carries only title, Story line, context, criteria and references (`editShape`, packages/contract/src/work.ts:606-618, which a split's edit uses through `PlanningEditFields`, :634-637), and the revise target has the same five fields (`ReviseTarget`, packages/engine/src/story-store/planning.ts:124-135; `revisedOf`, `differences` and `revisionCalls`, packages/engine/src/backlog/lane/stories.ts:240-288). Dependencies exist only for new stories: the lane passes `--dep` on create (stories.ts:204), and the session checks each one (`#checkNewStory`, packages/engine/src/run/planning-session.ts:1083-1127). The planning contract (packages/engine/src/prompts/contract/planning-box.md:44-48) lists the edit's fields and says nothing about dependencies.

The fix:
- Contract: `editShape` gains an optional `dependencies`, a list of task ids capped as a new story's (`proposalCaps.dependencies`, work.ts:453), described as the whole list, replacing the old one, as `--dep` does; an empty list clears them. An edit with only dependencies passes `editChecks`.
- Confirm: the session refuses an edit or split whose dependency is not an active task of the office or a story this session filed (the rule `#checkNewStory` uses), is the edited task itself, or would make a dependency cycle with the backlog's other dependencies (`cycleThrough`, packages/engine/src/gate/rules.ts:365-399). The message names the dependency, and nothing is journaled.
- Lane: `ReviseTarget` gains `dependencies`; when the set differs from the task's, `revisionCalls` writes it in one `task edit` call with a `--dep` per id (`--dep ""` for an empty list; the Backlog CLI 1.53 replaces the whole list), and `differences`, the read-back check, covers it. The same set writes nothing.
- Prompts: planning-box.md says an edit or split may set dependencies, as a whole list, and that the session never tells the maintainer to set dependencies by hand; the first message (packages/engine/src/prompts/task/planning.md) says the same where it lists what a session may propose.

DIPO-478 (m-4, Ready on main) adds a role field to the same edit, in the same places (editShape, ReviseTarget, revisionCalls, the read-back check). The two do not overlap in fields: whichever builds second follows the first's shape for an optional edit field, its confirm check and its revision call.

The draft's evidence lines: packages/contract/src/work.ts:606 "const editShape = {"; packages/engine/src/story-store/planning.ts:124 "export const ReviseTarget = z"; packages/engine/src/story-store/planning.ts:132 "references: z.array(z.string().min(1)).min(1).optional(),"; packages/engine/src/backlog/lane/stories.ts:204 "...target.dependencies.flatMap((dep) => [\"--dep\", dep]),". Origin: a planning session's aside; dipo idea: c722e358bfb50f49b6322fe3b4492edfd6e8f073a46559911a115028e95bb96e.

Replaces: the maintainer's hand edit of dependencies after a planning session; no engine mechanism is removed.

Not a guard: the dependency check is the proposal's validation, as a new story's is, and no deny rule, sandbox setting or permission check changes (R30 does not apply).

ADR 0022 section 2, the line "**An edit**" (line 25): its list "(wording, criteria, references, a split, a resolved unknown)" gains "dependencies".

Tier M: one optional field through contract, confirm, lane and prompts, with a cycle check reused.

```dipo
branch: "DIPO-493/planning-edits-set-dependencies"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit, planning-proposals) checkProposal accepts an edit with only dependencies, a split whose edit has only dependencies, and an empty dependencies list; it refuses more ids than proposalCaps.dependencies"
    - kind: "automated"
      check: "(unit, planning-world) confirming an edit whose dependency is unknown, is the edited task itself, or closes a cycle (A depends on B, the edit makes B depend on A) is refused naming the dependency and journals nothing; a lower-case id of a known task is accepted"
    - kind: "automated"
      check: "(unit, planning-world) an edit depending on a story this session filed whose backlog PR has not merged is accepted"
    - kind: "automated"
      check: "(fail-closed: the real Backlog CLI on a temporary backlog) a revise target with dependencies [DIPO-3] on a task depending on DIPO-1 and DIPO-2 leaves exactly DIPO-3; an empty list leaves none; the same set runs no task edit call; dependencies with a new title apply in one revision"
    - kind: "automated"
      check: "(unit, planning-contract) planning-box.md and the first message say an edit or split may set dependencies and that the session never asks the maintainer to set them by hand"
    - kind: "manual"
      check: "On the scratch repository, in a planning session ask Claude to make one existing story depend on another, confirm the edit, and wait for dipo's backlog PR to merge"
      expect: "Claude proposes an edit with the dependencies instead of asking you to edit by hand; after the merge the story lists exactly the new dependency"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An edit proposal with only a dependencies list passes the proposal schema, and so do a split whose edit has only dependencies and an empty list that clears them
- [ ] #2 Confirming an edit or split whose dependency is unknown, is the edited task itself or would make a dependency cycle is refused with a message naming the dependency, and nothing is journaled
- [ ] #3 A dependency on a story this planning session filed is accepted, as for a new story
- [ ] #4 A confirmed edit leaves the story with exactly the given dependencies once applied, an empty list leaves none, and the read-back check covers them
- [ ] #5 An edit naming the dependencies the story already has runs no task edit call, and dependencies with other fields apply in one revision
- [ ] #6 The planning contract and the first message say an edit or split can set dependencies and that the session never asks the maintainer to set them by hand
- [ ] #7 ADR 0022's edit line lists dependencies
<!-- AC:END -->
