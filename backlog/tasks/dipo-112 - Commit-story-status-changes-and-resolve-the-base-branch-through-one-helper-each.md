---
id: DIPO-112
title: >-
  Commit story status changes and resolve the base branch through one helper
  each
status: To Do
assignee: []
created_date: '2026-10-16 09:39'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/run/park.ts
  - packages/engine/src/run/story-git.ts
  - packages/engine/src/worktree/claim.ts
  - packages/engine/src/git/
  - packages/engine/src/backlog/lane/lane.ts
  - packages/engine/src/backlog/pr/feature.ts
  - packages/engine/src/office/init/init.ts
  - packages/engine/test/
priority: medium
type: chore
ordinal: 102000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: claim, In Review, park and unpark commit only the task file through one helper, and every caller resolves the base branch through one rule, so M1's new callers cannot add a fifth diverging copy.

Context: the status commit has four copies (packages/engine/src/worktree/claim.ts, packages/engine/src/run/story-git.ts, two in packages/engine/src/run/park.ts). The park and unpark copies run git commit with no pathspec, against park.ts's own header (only the task file is committed); anything staged would land under '<ID>: status Parked'. The base-branch rule has four copies with three failure behaviours (packages/engine/src/git/office.ts, packages/engine/src/backlog/lane/lane.ts, packages/engine/src/backlog/pr/feature.ts, packages/engine/src/office/init/init.ts), because OfficeGit.resolveBase is only a git queue item and the queue is not re-entrant (packages/engine/src/git/queue.ts). Found by the 2026-10-16 milestone review (duplication clusters D7, D8).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 One commitTaskFile helper (literal pathspecs, commit limited to the task file) plus one push helper are used by claim, In Review, park and unpark.
- [ ] #2 A session-level resolveBase in packages/engine/src/git/office.ts is the only base-branch rule; the three other copies are gone and their callers keep their current error codes.
- [ ] #3 A local (not CI-only) test stages another file before a park and shows it stays out of the park commit.
<!-- AC:END -->
