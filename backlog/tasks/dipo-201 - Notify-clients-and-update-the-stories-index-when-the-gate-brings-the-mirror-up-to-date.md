---
id: DIPO-201
title: >-
  Notify clients and update the stories index when the gate brings the mirror up
  to date
status: Refined
assignee: []
created_date: '2026-10-18 08:55'
updated_date: '2026-10-19 15:00'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies:
  - DIPO-200
references:
  - packages/engine/src/gate/store/feature.ts
  - packages/engine/src/stories/feature.ts
  - packages/engine/src/stories/index-stories.ts
  - packages/engine/src/run/work-run.ts
  - packages/engine/src/worktree/claim.ts
  - packages/daemon/src/foreground.ts
  - packages/engine/test/gate/
  - packages/engine/test/stories/
  - packages/engine/test/run/
  - packages/engine/test/reconcile/helpers.ts
priority: medium
type: bug
ordinal: 190000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: when a gate read brings the stories index mirror up to the gate's base commit, subscribed clients are told about the changes and the stories index does not read the same commit again.

Context: review of DIPO-180 (PR #197). When the mirror was read at an older `_base` commit, GateStore (packages/engine/src/gate/store/feature.ts, #otherTasks) runs indexPass directly inside the caller's git queue item. That pass writes story.state change-log entries, but nothing calls onOfficeChanged, StoryIndex's own state (its last sha and last pass, packages/engine/src/stories/feature.ts) is not updated, and the pass's branchUnread warnings are dropped. StoryIndex then runs another full pass at the same commit, finds no change, and also notifies nobody, so a TUI or office.summary client misses the changes until something else changes. A second, smaller gap from the same review: the work.run claim recheck reads with a checkout and no session, so a stale mirror there falls back to one Backlog CLI view per task instead of a pass. GateStore has no StoryIndex dependency today; both are built in packages/daemon/src/foreground.ts, and the engine harnesses packages/engine/test/run/run-office.ts, packages/engine/test/run/work-run.ci.test.ts and packages/engine/test/reconcile/helpers.ts build them too. The claim recheck is the recheck closure in packages/engine/src/run/work-run.ts, with its signature in packages/engine/src/worktree/claim.ts. DIPO-200 also changes claim.ts, so this story follows it.

```dipo
branch: "DIPO-201/gate-pass-notifies-clients"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) after a gate read that runs an index pass, the office-changed callback fires once with the pass's change-log cursor, and the stories index's next poll at the same base sha runs no pass"
    - kind: "automated"
      check: "(unit) a branchUnread warning from the gate's pass is logged as from the index's own pass"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The index pass a gate read runs goes through StoryIndex (one method that takes the caller's git session), so StoryIndex's last sha and last pass are updated, its branchUnread warnings are logged, and onOfficeChanged is called when the pass wrote change-log entries
- [ ] #2 After such a gate read, the next stories index poll at the same base sha runs no pass; a test counts the passes
- [ ] #3 The work.run claim recheck with a stale mirror brings the mirror up to date through the same method instead of viewing every task, or the report evidence says why it cannot and the per-view fallback stays
<!-- AC:END -->
