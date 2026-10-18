---
id: DIPO-180
title: Answer dipo gate without one Backlog CLI view per task
status: Done
assignee: []
created_date: '2026-10-17 17:00'
updated_date: '2026-10-18 07:45'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/gate/
  - packages/engine/test/gate/
  - packages/engine/src/stories/
  - packages/engine/test/stories/
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/test/db/
  - packages/cli/src/gate-command.ts
  - packages/cli/src/gate-command.test.ts
priority: high
type: bug
ordinal: 169000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo gate <id>` answers well under the CLI's reply timeout on a backlog of 200 or more tasks, because the Ready gate reads the other active tasks without one Backlog CLI view each, and the command waits as long as that read can take.

Context: a gap from the first M1a setup (2026-10-17), first filed as a recovering-daemon problem; the cause turned out to be the gate read itself. `dipo gate <id>` printed `dipo: the daemon did not answer within 10 s.` four times, once 15 minutes after recovery had ended. readGateInput (packages/engine/src/gate/store/read.ts) runs `backlog task list --plain` and then `backlog task <id> --plain` for every listed task (169 on main) with VIEW_CONCURRENCY 4 (packages/engine/src/stories/read.ts), about 0.17 s each, so one story.gate read takes 11 to 13 s. The gate command (packages/cli/src/gate-command.ts) waits REPLY_TIMEOUT_MS, 10 s (packages/cli/src/daemon-commands.ts). work.preview and work.run evaluate the same gate (checkGate in packages/engine/src/gate/store/feature.ts) under the longer RUN_TIMEOUT_MS: `dipo run --dry-run DIPO-123` took 12.9 s, and `dipo run DIPO-123` took 44 s to print started.

From each other task the gate needs only its id, status, dependencies and field-block branch (GateTask in packages/engine/src/gate/types.ts; R13, R14, R19). `backlog task list --json` (Backlog.md 1.53) gives ids and statuses in one call, but no dependencies and no description. The stories index already reads every task view on its poll (packages/engine/src/stories/index-stories.ts) and writes a mirror row per story (backlog_mirror, writeMirror in packages/engine/src/stories/apply.ts), without dependencies or branch. One way: the index pass also stores those two in the mirror, and the gate reads the mirror when it was read at the `_base` commit the gate reads, and reads only the target story and the milestones through the CLI. DIPO-179 adds open dependencies to the story.gate result and touches the same files.

```dipo
branch: "DIPO-180/gate-without-per-task-views"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a story.gate read on a 200-task fixture makes a fixed number of Backlog CLI calls and gives the same rule results as reading every view"
    - kind: "automated"
      check: "(unit) task data read at an older base commit is brought up to the gate's base before the gate uses it"
    - kind: "manual"
      check: "(live) on this repository run dipo gate DIPO-123 and time it"
      expect: "the result prints in under 3 s; no did-not-answer line"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 One story.gate read makes a number of Backlog CLI calls that does not grow with the number of tasks, and a test counts the calls for a fixture backlog of 200 tasks
- [x] #2 The rule results do not change: on a fixture backlog with a dependency cycle, a dependency that is not an active task and a branch used twice, the new read gives the same R13, R14 and R19 failures as reading every task view
- [x] #3 When the stored data of the other tasks was read at a different `_base` commit than the one the gate reads, the gate brings it up to that commit first, so a decision never uses task data older than its base
- [x] #4 `dipo gate` waits with a reply timeout sized for the story.gate read, stated in a comment with the measured time, and on this repository it prints its result in under 3 s, measured and stated in the PR
- [x] #5 work.preview and work.run use the same read for their gate evaluation, and their existing gate tests pass
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M56YJ4A3GWVPK7EY2NG55FM1 (Sonnet medium, 113 turns, about $1.63, 11 min) reported done, all five criteria, In Review on DIPO-180/gate-without-per-task-views; the live timing of criterion 4 was left open in its notes. Verify outside the sandbox on DIPO-180/gate-without-per-task-views-finish (origin/main merged in): 3251 pass, 2 skip, 0 fail.

Criterion 4, live (maintainer side, 2026-10-18, this repository, 199 task files): the main binary at b885cf3 printed `dipo: the daemon did not answer within 10 s.` twice (10.11 s, 10.15 s). A dipo built from this branch, on a copy of the temp DIPO_HOME (the branch adds migration 0031): `dipo gate DIPO-123` 0.49, 0.49, 0.50, 0.51, 0.49 s, no did-not-answer line. The first read right after a daemon restart took 17.04 s including the recovery wait and answered; the next read 0.50 s.

Review passed. Applied on top: the GATE_TIMEOUT_MS comment states the measured time instead of an unmeasured figure, and says the stale-mirror read is a full index pass. Left as follow-ups: the gate's in-session index pass does not notify subscribed clients or update StoryIndex's own state; the work.run claim recheck (a checkout, no session) falls back to the per-view read when the mirror is stale.
<!-- SECTION:NOTES:END -->
