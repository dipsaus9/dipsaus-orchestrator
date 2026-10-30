---
id: DIPO-384
title: 'Park a worker host found dead at recovery, as 0005 and 0008 say'
status: In Progress
assignee: []
created_date: '2026-10-30 09:30'
updated_date: '2026-10-30 17:56'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-355
references:
  - packages/engine/src/run/reattach.ts
  - packages/engine/src/run/
  - docs/decisions/0008-worker-adapter.md
priority: medium
type: chore
ordinal: 364000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker host found dead without exit.json at daemon recovery parks its story worker-failed, as 0008's host table and 0005 already say, instead of getting one resume.

Found by the review of PR #458 (DIPO-355): `onHostLost` still gives such a host one resume (DIPO-57 behaviour). One mechanism per goal (0001): the resume path for a lost host goes. 0005, 0008, 0020.

```dipo
branch: "DIPO-384/park-dead-host"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a host found dead without exit.json at recovery parks its story worker-failed, with no resume"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A host found dead at recovery without exit.json parks its story worker-failed with no automatic resume, shown by a test with a real exited process
- [x] #2 The one-resume path for a lost host is removed: RunOutcomesPort.onHostLost, its control callers, temp-dirs.ts and the tests that call it; the host-lost signal and HOST_LOST_END stay only as far as the park needs them, and the PR says which
- [x] #3 0005 and 0008 stay true to the code; any sentence that mentions a resume for a lost host is corrected
<!-- AC:END -->
