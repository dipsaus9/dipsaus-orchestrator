---
id: DIPO-328
title: Tear down a Done story's worktree once its worker hosts sent their exit
status: Refined
assignee: []
created_date: '2026-10-23 10:50'
updated_date: '2026-10-23 11:06'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/worktree/done.ts
  - packages/engine/src/worktree/done-elsewhere.ts
  - packages/engine/test/worktree/teardown.test.ts
priority: high
type: bug
ordinal: 313000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found on the first run that dipo merged itself (DIPO-325, 2026-10-23). The Done teardown waited while a worker host of the run had no worker_hosts end time, but only the re-attach after a daemon restart sets that time; in a run without a restart the ingestor records the host's exit code and leaves the end time empty. So every Done story kept its worktree and its claim (engine.notice teardown.kept: a worker of its run is still running), which also shows as leftovers on the desk.

```dipo
branch: "DIPO-328/record-host-end"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) teardown.test.ts: a host with an exit code and no end time does not keep the worktree; a host with neither still does"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The Done teardown treats a worker host whose exit line was ingested (its exit code is set) as ended, also for rows written before this fix
- [ ] #2 A host with neither an exit code nor an end time still keeps the worktree
- [ ] #3 Tests in teardown.test.ts cover both
- [ ] #4 The done-elsewhere check (hasLiveWorker) uses the same rule
<!-- AC:END -->
