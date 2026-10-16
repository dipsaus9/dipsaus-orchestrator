---
id: DIPO-104
title: See stories merged to the base branch without a manual rescan
status: Done
assignee: []
created_date: '2026-10-15 19:23'
updated_date: '2026-10-16 07:20'
labels:
  - 'tier:S'
milestone: m-0
dependencies: []
references:
  - packages/engine/src/stories/feature.ts
  - packages/engine/src/stories/apply.ts
  - packages/engine/src/commands/execute.ts
  - packages/engine/src/commands/registry.ts
  - packages/engine/test/commands/execute.test.ts
  - packages/engine/test/stories/index.ci.test.ts
  - packages/engine/test/run/work-run.ci.test.ts
priority: medium
type: feature
ordinal: 94000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a story added or changed on the office base branch (for example a Ready story merged by PR) appears in the daemon's view within polling.fetchSeconds, without dipo office rescan or a daemon restart.

Context: seen in the DIPO-84 test on 2026-10-15: TASK-5 was merged to the scratch repo main while a daemon was running, and dipo did not see it until a rescan. The fetch loop is meant to index again when _base moved (packages/engine/src/stories/feature.ts:3); why it did not is unknown.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The cause is reproduced with a test and written in the story notes.
- [x] #2 A story merged to the remote base branch while the daemon runs shows in the office stories within one fetch interval, and work.run can pick it.
- [x] #3 A test with a temp remote covers the merge-then-poll case.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Cause (reproduced 2026-10-15 with a real `dipo daemon --foreground`, a temp bare remote and the Backlog fixture, plus the tests below):
- The fetch poll works. With polling.fetchSeconds 3, a story pushed to origin/main was indexed about 3 s later (log "stories indexed", added 1): the poll fetched, saw origin/main move, moved _base and ran the index pass. The default interval is 300 s, so without a command the story shows up to 5 minutes later.
- A command that names the new story did not wait for that poll and did not refresh. `dipo stop TASK-4` (and `dipo run TASK-4`) failed with "story.unknown: No story has the id TASK-4." until the next poll or `dipo office rescan`. The executor (packages/engine/src/commands/execute.ts) resolves story references against the database before the handler runs, so the fetch and index pass that work.run runs first never got the chance. `dipo run --dry-run` is the read work.preview, which by design shows the base as last fetched.
Fix: a story refresh hook in the registry (registerStoryRefresh). When an office command names a story the office does not know, the executor runs the refresh once (StoryIndex.refresh: fetch, then an index pass when _base moved, serial with the poll), then resolves again. It still fails with story.unknown when the story is still missing or the refresh fails. Reads (dipo gate, work.preview) are unchanged.
Tests: packages/engine/test/commands/execute.test.ts (refresh once, still unknown, failing refresh), packages/engine/test/stories/index.ci.test.ts (new story merged to a temp remote is indexed at the next poll and at once on refresh), packages/engine/test/run/work-run.ci.test.ts (work.run by id of a story merged after load starts it).
<!-- SECTION:NOTES:END -->
