---
id: DIPO-472
title: Seed the developer role file and label existing stories in office init
status: In Progress
assignee: []
created_date: '2026-11-10 14:58'
updated_date: '2026-11-13 10:25'
labels:
  - 'tier:M'
milestone: m-4
dependencies:
  - DIPO-471
references:
  - packages/engine/src/backlog/init/init.ts
  - packages/engine/src/backlog/init/ops.ts
  - packages/engine/src/prompts/roles/developer.md
  - packages/engine/src/story-store/fields/labels.ts
  - packages/engine/src/roles/
  - docs/decisions/0017-testing-strategy-and-configuration.md
  - docs/decisions/0001-foundational-decisions.md
type: feature
ordinal: 445000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want office init to add the developer role as a file and label my open stories with it so that my office keeps running when every story must name a role.

Office init (packages/engine/src/backlog/init/init.ts) plans target-state steps from the base (planInit, line 102) and applies them as commits on one backlog PR. The gitignore step (init.ts:132, ops.ts:42) is the model for a step that adds a missing file.

The maintainer decided (planning 2026-11-10) that the built-in developer role becomes a file, that init writes it only while the office has no role files, and that init labels the active stories that have no role label. Two new steps, each planned only while the base's .dipo/roles/ holds no role file (*.md):
- roles: writes .dipo/roles/developer.md with version 1, a one-line purpose and, as its body, the bundled developer instructions (packages/engine/src/prompts/roles/developer.md). The written file must load with the role-file parser of DIPO-471.
- roleLabels: adds the label role:developer to every task on the base that is not Done and has no role: label (readLabels, packages/engine/src/story-store/fields/labels.ts:30). It goes through the Backlog CLI as the other steps do. BaseState (init.ts:65) gains what the plan needs: whether role files exist and each task's labels.

Both steps follow init's target-state rules: a step already true on the base or already open in the journal is not journaled again, so a second init adds no commits. Once a role file is on the base, neither step is planned, so a maintainer who later removes the developer role is left alone. A task that already has a role label is never changed.

The bundled developer.md stays in the binary as the seed text. Which code still reads it for runs is the job of the story that makes runs follow the role label.

Amend 0017 section 5 (the seed) and the office init description in the decisions to name both steps.

```dipo
branch: "DIPO-472/seed-developer-role-file-label-existing"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "planInit on a base without role files plans the seed step and the label step; on a base with one role file it plans neither."
    - kind: "automated"
      check: "Applying the seed step on a temporary repository writes .dipo/roles/developer.md, and the role-file parser loads it as developer with the bundled instructions."
    - kind: "automated"
      check: "Applying the label step adds role:developer to Refined and Ready tasks without a role label, and leaves a Done task and a task labelled role:designer unchanged."
    - kind: "automated"
      check: "A second init run on the same base journals no new step and adds no commit."
    - kind: "manual"
      check: "Run dipo office init on the dipo repository once this story is merged, and read the backlog PR it opens."
      expect: "The PR adds .dipo/roles/developer.md and adds role:developer to the open stories that lacked a role label, and to nothing else."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Office init on a base with no file under .dipo/roles/ journals a step that writes .dipo/roles/developer.md, and the written file loads as the developer role with the role-file parser.
- [ ] #2 The seeded developer.md holds version 1, a purpose and, as its body, the bundled developer instructions.
- [ ] #3 Office init on a base with no role files adds role:developer to every task that is not Done and has no role label, and changes no task that already has a role label.
- [ ] #4 Office init on a base that holds at least one role file journals neither the seed step nor the label step.
- [ ] #5 A second office init after the first one's steps are journaled or merged adds no commits for either step.
- [ ] #6 The decisions describe the two new init steps and when they apply.
<!-- AC:END -->
