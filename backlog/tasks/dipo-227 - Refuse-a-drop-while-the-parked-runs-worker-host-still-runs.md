---
id: DIPO-227
title: Refuse a drop while the parked run's worker host still runs
status: In Review
assignee: []
created_date: '2026-10-20 08:20'
updated_date: '2026-10-20 14:45'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/stories/planning.ts
  - packages/daemon/src/foreground.ts
  - packages/contract/src/office.ts
  - packages/engine/test/backlog/planning.test.ts
  - packages/engine/test/backlog/planning.ci.test.ts
priority: high
type: bug
ordinal: 227000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: story.drop no longer removes the worktree of a parked run whose worker host still runs; it answers the retryable run.hostAlive and changes nothing, as 0020 section 8 sets for work.discard.

Context: review of DIPO-160 (PR #251). drop in packages/engine/src/stories/planning.ts refuses a story with an active run or In Progress or In Review, checks dependents and, without deleteBranch, the dirty files; then it journals the drop, closes the story PR and calls releaseForDrop (packages/engine/src/worktree/release.ts), which with deleteBranch runs `git worktree remove --force`. Nothing checks the worker hosts of the claim's run, and a parked run's host can still run after the park while its worker exits (0006 decision 8). 0020 section 8 gives work.discard "run.hostAlive while the host lives", and its note of 2026-10-20 (DIPO-227) gives story.drop the same answer while a worker host of the parked run still runs, with nothing changed; work.discard is still provisional with no handler on main, and today the park resume answers run.hostAlive (Resume.#earlierHostAlive in packages/engine/src/run/resume.ts, with hostAlive and workerHostsOf of packages/engine/src/runs/worker-hosts.ts). run.hostAlive is one of 0005's retryable codes, so a client offers a retry. StoryPlanningDeps have no process probe; packages/daemon/src/foreground.ts builds StoryPlanning. The storyDrop comment in packages/contract/src/office.ts lists its errors.

```dipo
branch: "DIPO-227/drop-waits-for-parked-host"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a parked story whose run's worker host lives is refused with run.hostAlive, with and without deleteBranch; nothing is journaled, closePr is not called and the fake git's worktree is untouched"
    - kind: "automated"
      check: "(unit) the same drop passes once the host has exited, and a story without a claim drops as before"
    - kind: "automated"
      check: "(unit) the daemon builds StoryPlanning with the engine's process probe"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 story.drop checks every worker host of the live claim's run (workerHostsOf with hostAlive and the engine's process probe) before it journals, closes the story PR or touches the worktree; while one lives it fails with the retryable run.hostAlive naming the story and the host PID and saying to drop again in a moment, with and without deleteBranch, and nothing is journaled, closed or removed
- [x] #2 A story without a live claim, or whose claim's hosts have all exited, drops as it does today
- [x] #3 StoryPlanningDeps take the process probe, packages/daemon/src/foreground.ts passes the engine's, and the storyDrop comment in packages/contract/src/office.ts names run.hostAlive among its errors
- [x] #4 Tests in packages/engine/test/backlog/planning.test.ts show the refusal with a live host for both values of deleteBranch (no journal entry, closePr not called, the fake git's worktree untouched) and the drop passing once the host is gone
<!-- AC:END -->
