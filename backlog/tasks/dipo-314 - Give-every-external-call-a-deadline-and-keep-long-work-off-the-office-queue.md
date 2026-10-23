---
id: DIPO-314
title: Give every external call a deadline and keep long work off the office queue
status: Done
assignee: []
created_date: '2026-10-22 21:00'
updated_date: '2026-10-23 14:18'
labels:
  - 'tier:L'
milestone: m-1
dependencies: []
references:
  - packages/contract/src/runtime.ts
  - packages/daemon/src/foreground.ts
  - packages/engine/src/backlog/pr/feature.ts
  - packages/engine/src/backlog/runner.ts
  - packages/engine/src/commands/execute.ts
  - packages/engine/src/git/feature.ts
  - packages/engine/src/git/index.ts
  - packages/engine/src/git/runner.ts
  - packages/engine/src/index.ts
  - packages/engine/src/merge-slot/slot.ts
  - packages/engine/src/merge-slot/story-slot.ts
  - packages/engine/src/office/repository.ts
  - packages/engine/src/platform/deadline.ts
  - packages/engine/src/platform/host.ts
  - packages/engine/src/platform/pr-state.ts
  - packages/engine/src/platform/process.ts
  - packages/engine/src/platform/repo-files.ts
  - packages/engine/src/run/places.ts
  - packages/engine/src/run/work-run.ts
  - packages/engine/src/stories/feature.ts
  - packages/engine/src/stories/index-stories.ts
  - packages/engine/src/stories/read.ts
  - packages/engine/src/story-pr/prs.ts
  - packages/engine/src/worktree/claim.ts
  - packages/engine/src/worktree/done.ts
  - packages/engine/test/backlog/deadline.test.ts
  - packages/engine/test/backlog/lane/failures.test.ts
  - packages/engine/test/backlog/runner.test.ts
  - packages/engine/test/git/build-commit.test.ts
  - packages/engine/test/git/deadline.test.ts
  - packages/engine/test/git/unit.test.ts
  - packages/engine/test/platform/deadline.test.ts
  - packages/engine/test/platform/hanging.ts
  - packages/engine/test/platform/pr-state.test.ts
  - packages/engine/test/reconcile/helpers.ts
  - packages/engine/test/run/work-run.test.ts
  - packages/engine/test/stories/view-cache.test.ts
  - packages/engine/test/worktree/setup.test.ts
  - packages/engine/test/worktree/teardown.test.ts
type: enhancement
ordinal: 299000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: no Backlog CLI, gh or git call can hang an office. Each call has a deadline, after which the process is killed and a coded error is raised that the existing notice, retry and park paths handle. One PR-state poll per office feeds every consumer, and a slow box preparation or story index pass no longer holds the office's serial work.

Context:
- `runBacklog` (`packages/engine/src/backlog/runner.ts`) and `GhHost.#raw` (`packages/engine/src/platform/host.ts`) wait for their child with no deadline. Only these have one:
  - `#tailRun`;
  - git's `execWithTimeout` (`packages/engine/src/git/runner.ts`), which git applies to commit, push and fetch only.
- The caller-side deadline in `commands/execute.ts` neither kills the child nor frees the queue.
- The story index pass (`stories/index-stories.ts`) is one office queue item, with one CLI view per story and no cache.
- The serialized pickup step in `run/work-run.ts` covers the claim, the box preparation with its install, and the launch. DIPO-208 and DIPO-229 keep starts from taking the same place twice, and this story keeps those guarantees.
- Three pollers per office read PR state on `prStateSeconds`: `merge-slot/slot.ts`, `story-pr/prs.ts` and `worktree/done.ts`.
- Calls to the box backend already have deadlines (`box/apple-container.ts`).

```dipo
branch: "DIPO-314/deadlines-and-office-queue"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `runBacklog` kills the CLI's process group after a deadline (default 60 s; design choice, not a maintainer decision) and throws a coded `timedOut` error that names the command and the deadline. The deadline runs on the engine clock.
- [x] #2 Every gh call through `GhHost` has the same kind of deadline and error. `#tailRun` keeps its own.
- [x] #3 Every git step has a default deadline, and commit, push and fetch keep theirs.
- [x] #4 A timed-out call frees its office queue item. `work.run`, the backlog lane, teardown and the Done poll treat it as a failure they already handle: a notice, a retry or a park.
- [x] #5 One PR-state poll per office reads each open PR once per interval and passes the result to the merge slot, the story-PR poll and the Done poll.
- [x] #6 The pickup's serialization ends once the claim row is committed, so box preparation, install and launch run outside it. Two pickups in one office still never take the same story or place.
- [x] #7 Within one index pass, the CLI does not read again a story whose task file blob is unchanged.
- [x] #8 Tests cover: each deadline, the freed queue and the error, with a manual clock and a fake process that never exits; the single poll; the narrowed pickup.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Done 2026-10-23 (maintainer session): built outside dipo, reviewed by a separate agent (all 8 criteria met; its advisories are fixed: SIGTERM before SIGKILL so git removes its locks, detached calls killed at daemon stop, round-scoped PR reads, cache invalidation for new ids and other backlog folders). Deadlines: 60 s for Backlog CLI and gh calls, 120 s for local git steps, 60 s for commit, push and fetch
<!-- SECTION:NOTES:END -->
