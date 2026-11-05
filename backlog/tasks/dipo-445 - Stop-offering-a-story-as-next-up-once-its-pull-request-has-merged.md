---
id: DIPO-445
title: Stop offering a story as next up once its pull request has merged
status: Refined
assignee: []
created_date: '2026-11-05 12:06'
updated_date: '2026-11-05 12:12'
labels:
  - 'tier:S'
milestone: m-2
dependencies: []
references:
  - packages/engine/src/run/next-up.ts
  - packages/engine/src/worktree/done.ts
  - packages/engine/src/worktree/teardown.ts
  - packages/engine/src/worktree/done-check.ts
  - packages/engine/src/stories/feature.ts
  - packages/engine/src/run/work-run.ts
  - packages/engine/test/run/next-up.test.ts
priority: high
type: bug
ordinal: 418000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want dipo to stop offering a story as next up once its pull request has merged, so that my desk never shows finished work as the next thing to start.

Found by M2's closing hand test (2026-11-05, scratch repository). Blocks M2 (maintainer's decision). After three stories merged, the desk offered all three again as NEXT UP for about 3.5 minutes, with the desk notification. The Done poll releases the claim at the merge (packages/engine/src/worktree/done.ts calls tearDown in packages/engine/src/worktree/teardown.ts, which releases the claim), but next up reads the backlog mirror's Ready status and the live claims (packages/engine/src/run/next-up.ts), and the mirror only moves when the stories poll fetches _base every polling.fetchSeconds (default 300 s, packages/engine/src/stories/feature.ts). A confirm in that window is already refused: work.run fetches and indexes first and skips a Done story as notRunnable.

The fix, one mechanism: next up skips a story whose story pull request dipo has recorded as merged, so it needs no extra fetch. The refusal of a confirm stays as it is and gets a regression test.

Built by builder agents: it changes dipo's own run path.

```dipo
branch: "DIPO-445/no-next-up-after-merge"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) next-up tests: a story whose pull request is recorded merged is not offered while the mirror still says Ready"
    - kind: "automated"
      check: "(unit) regression test: a confirm of a story whose pull request merged is refused as not runnable and starts no run"
    - kind: "manual"
      check: "On the scratch repository, let a confirmed story merge and read dipo desk right after the merge"
      expect: "The merged story is not offered as next up at any moment after its merge"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A story whose story pull request dipo recorded as merged is never offered as next up, also while the backlog mirror still says Ready
- [ ] #2 The check uses the merge dipo already records and adds no fetch of the base
- [ ] #3 A confirm of a story whose pull request merged is refused as not runnable and starts no run, shown by a regression test
<!-- AC:END -->
