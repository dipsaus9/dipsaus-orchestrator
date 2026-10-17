---
id: DIPO-179
title: List open dependencies in the dipo gate output
status: Done
assignee: []
created_date: '2026-10-17 17:00'
updated_date: '2026-10-17 22:39'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/contract/src/
  - packages/contract/schema/
  - packages/engine/src/gate/
  - packages/engine/test/gate/
  - packages/cli/src/gate-command.ts
  - packages/cli/src/gate-command.test.ts
priority: medium
type: enhancement
ordinal: 168000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo gate <id>` names the dependencies that are not Done next to its verdict, so the maintainer sees at once that a story which passes the gate will still wait before pickup.

Context: gap (a) from the first M1a setup (2026-10-17). `dipo gate <id>` printed `ready <ID> passed` for a story whose dependencies were not Done. That verdict is correct: the Ready gate asks only that each dependency is an active task (R13, 0012 section 3), and pickup skips a Ready story with open dependencies (openDependencies in packages/engine/src/run/select.ts, used by packages/engine/src/run/work-run.ts and for StoryView.waitingOn in packages/engine/src/stories/read.ts). The gate command (packages/cli/src/gate-command.ts) shows only the verdict. The gate result stays as it is and gains the open dependencies as data, an optional field in the unreleased contract minor.

```dipo
branch: "DIPO-179/gate-lists-open-dependencies"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) story.gate returns waitingOn with the ids and statuses of open dependencies, and none when all are Done"
    - kind: "automated"
      check: "(unit) dipo gate prints the waits-on line after the passed line or the failure lines, with exit codes 0 and 1"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The story.gate result carries an optional waitingOn list with each dependency of the story that is not Done on the base, its id and its status there (missing when it cannot be read), from openDependencies; packages/contract/schema/ is regenerated and packages/contract/src/version.ts notes the addition
- [x] #2 `dipo gate <id>` for a passing story prints `ready <ID> passed` and then one line `waits on <ID> (<status>), ...` naming the open dependencies, and exits 0; with none open it prints only the passed line
- [x] #3 For a failing story the command prints its failure lines as today, then the waits-on line when dependencies are open, and exits 1
- [x] #4 Tests cover a passing story with two open dependencies, a passing story whose dependencies are all Done, and a failing story with an open dependency, in packages/cli/src/gate-command.test.ts and packages/engine/test/gate/
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M55ZSFANV2MQZQ9ARBAJVE6C (Haiku low, 49 turns, about $0.05, 4 min) reported done. story.gate carries an optional waitingOn (GateDependency id, status?), set from openDependencies in gate/store/read.ts (the pure gate core may not import it; its purity test). dipo gate prints 'waits on DIPO-3 (Ready), DIPO-4 (Refined)' after the verdict line or after the failures; a dependency whose status the CLI could not read prints '(status unknown)'; waitingOn is left out when nothing is open. Verify outside the sandbox on DIPO-179/gate-lists-open-dependencies-finish: 3211 pass, 2 skip, 0 fail; DIPO_TEST_CI=1 gate and cli 344 pass.

Review advisory applied: a dependency whose status cannot be read prints '(missing)', the story's word and the Backlog CLI's own state name.
<!-- SECTION:NOTES:END -->
