---
id: DIPO-142
title: >-
  Reopen the story's run for review and fix rounds, with a worker place and a
  reviewer place
status: In Review
assignee: []
created_date: '2026-10-17 12:51'
updated_date: '2026-10-18 14:02'
labels:
  - 'tier:L'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-115
  - DIPO-128
  - DIPO-129
  - DIPO-138
references:
  - packages/engine/src/run/
  - packages/engine/src/worktree/done.ts
  - packages/engine/src/views/work.ts
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/test/run/
  - packages/engine/test/db/
  - packages/contract/src/
  - packages/contract/schema/
  - packages/daemon/src/runs.ts
  - packages/daemon/src/foreground.ts
priority: high
type: feature
ordinal: 131000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a story run ends its active period at In Review and reopens for a review, a fix round or a conflict hand-off; each office has one worker place and one reviewer place with their start orders, plan-limit holds pause the places by scope, review time and turns stay out of the developer's caps, every park records its cause, and the final outcome is written at Done.

Context: implements ADR 0019 section 13 (the run across review rounds: one run per claim whose active periods end and reopen, as reopenParkedRun does) and section 12 (capacity and plan limits: two places per office, start orders, counting, plan limits by scope); a resume that finds its place taken is queued (0020 section 1). Today activeRuns counts every unended session run (0019 fact 11), a finding of the 2026-10-16 milestone review. This story also adds the parks.cause column of 0020 section 2, which the parks of the review loop write and the resume stories read.

```dipo
branch: "DIPO-142/run-reopen-and-session-places"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(migration) parks.cause exists, and a park written by run control records its cause and emits story.parked with it"
    - kind: "automated"
      check: "(unit) a run reopened after In Review keeps its loop count and its minute cap leaves out the idle and review time"
    - kind: "automated"
      check: "(unit) place counting leaves session runs out while activeRuns and hasActiveRun count them"
    - kind: "automated"
      check: "(unit) start order in each place, and a resume queued while its place is taken"
    - kind: "automated"
      check: "(unit) a session hold, a model-family hold and allowed_warning pause the right places"
    - kind: "automated"
      check: "(migration) the run_outcomes columns exist and Done writes the final row"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A story run ends its active period at In Review and reopens on the same run for a review round, a fix round or a conflict hand-off, adding the idle time to the run's parked total so the developer's minute cap counts developer working time only
- [x] #2 Each office has a worker place and a reviewer place; story capacity counts open story runs with a live or starting session per place from the agent's role and leaves session runs out, while activeRuns and hasActiveRun still count session runs; work.run keeps refusing maxAgents above 1
- [x] #3 The worker place starts maintainer resumes first, then conflict hand-offs and fix rounds, then new pickups; the reviewer place starts maintainer resumes of a review first, then pending reviews oldest In Review first; a resume that finds its place taken is accepted and starts when the place frees
- [x] #4 Plan-limit holds pause places by scope: a session or weekly hold pauses both places in every office, a model-family hold pauses the place whose session uses that family, allowed_warning stops new sessions of that scope; a waiting story shows health limited and never parks
- [x] #5 Reviewer turns and minutes are kept out of the developer's turn and minute caps and the CLI --max-turns remainder, while the run's usage and story budget include the reviewer agent's tokens
- [x] #6 Each end rewrites the provisional run_outcomes row, and Done writes the final row (end kind done) with new columns for loops, review rounds, failed review rounds, CI attempts, conflict hand-offs and override, through a migration
- [x] #7 parks gains a cause column through a migration, every park the engine writes records its cause (an open string, from the causes of ADR 0020 section 2), and the story.parked event carries cause in the contract and its generated schema
<!-- AC:END -->
