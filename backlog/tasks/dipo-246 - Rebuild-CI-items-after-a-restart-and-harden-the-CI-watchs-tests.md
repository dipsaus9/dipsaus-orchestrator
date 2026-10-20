---
id: DIPO-246
title: Rebuild CI items after a restart and harden the CI watch's tests
status: In Progress
assignee: []
created_date: '2026-10-20 18:35'
updated_date: '2026-10-20 23:19'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/story-pr/prs.ts
  - packages/engine/test/story-pr/ci.test.ts
priority: medium
type: bug
ordinal: 246000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a red head's CI items survive a daemon restart, a park that keeps failing warns once per head instead of every poll, and the CI watch's tests pin the aggregate job, the stuck-head interval and the park retry.

Context: advisories of the DIPO-147 review (PR #266). In packages/engine/src/story-pr/prs.ts #red builds the head's CI items (one log read per failed check) only when the head's `ci` run step is not yet recorded, and keeps them in memory (`watch.items`) for the fix round (file comment: "The items stay in memory for the fix round"). After a daemon restart the step is recorded, so the items are never rebuilt: a later CI-cap park detail and the fix round (DIPO-148, not built yet, which will store items when it sends them) get none. A park that fails returns false, so the next poll tries again and logs "parking the story on red checks failed" every poll interval while it keeps failing. Tests in packages/engine/test/story-pr/ci.test.ts: "builds one item for a failed job ..." asserts the aggregate ci-ok item with a broad text match only; "raises one ci.stuck after checksWaitMinutes and then reads every 10 minutes" advances the clock by CI_STUCK_POLL_MS from the code, so a changed interval would not fail it; no test covers the park retry after a failed park.

```dipo
branch: "DIPO-246/ci-items-after-restart"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) ci.test.ts: a red head whose ci step was recorded before a restart (new PrPoller, same database) rebuilds its items on the next poll, reading each failed job's log once, and appends no second ci step"
    - kind: "automated"
      check: "(unit) ci.test.ts: a park that fails three polls in a row writes one warn for the head, then a park that succeeds parks the story verify-failing with cause ci"
    - kind: "automated"
      check: "(unit) ci.test.ts: the stuck-head test advances the clock by a literal 10 minutes; the aggregate item test asserts the aggregate's check name, no steps and the 'other jobs of its workflow run failed' wording with the failed job named"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 When a red head's `ci` run step is recorded but no CI items for that head are in memory (after a daemon restart), the next poll rebuilds them, reading each failed job's log once, without appending a second `ci` step, so the CI-cap park detail and the fix round get them
- [ ] #2 A park on red checks that keeps failing writes its warn once per head and run; later failed attempts for the same head log at debug, and a later success parks as today
- [ ] #3 packages/engine/test/story-pr/ci.test.ts covers the rebuild after a restart and the park retry with one warn, its stuck-head test advances the clock by a literal 10 minutes, and its aggregate item test asserts the check name, empty steps and the wording that names the failed job
<!-- AC:END -->
