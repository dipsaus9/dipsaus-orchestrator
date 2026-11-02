---
id: DIPO-421
title: 'Show an ended run as ended in an open TUI, and name the story in the checklist'
status: Refined
assignee: []
created_date: '2026-11-02 09:14'
updated_date: '2026-11-02 09:16'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - packages/client/src/store/
  - packages/tui/src/app.tsx
  - packages/tui/src/checklist.tsx
  - packages/tui/src/overview.tsx
  - packages/client/test/
  - packages/tui/src/
priority: low
type: bug
ordinal: 399000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an open TUI shows a run's end as soon as the stream carries it, and the test checklist speaks of the story by its id and offers the shell line.

Found in the TUI hand test of 2026-11-02 on the scratch office (binary ca71ee54, story TASK-19 flagged test-before-merge, a product with nothing to start). After `test.record` pass at 09:08:31 dipo merged PR #36 at 09:09:03, but the open TUI still listed TASK-19 under RUNNING ("reviewer S test busy, now: testing") at 09:09:58, while a TUI started then showed "0 running". The open TUI caught up only by 10:11, when the story turned Done. DIPO-322 asks for a run's end within 5 s. The office store is packages/client/src/store/. In the checklist, while `t` sent `test.start`, the TUI showed "No test is open for sto_01M6DQB3NFKWSQ5ZVKZDJ0GK6N." (packages/tui/src/app.tsx about line 1102), an internal key, and after the reply it showed the checkout name but not the `dipo test shell TASK-19` line the reply carries (DIPO-309).

0009.

```dipo
branch: "DIPO-421/tui-run-end-and-checklist"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(TUI) an open overview drops a run from RUNNING within 5 s of its end event, and the checklist names the story id and shows the test shell line"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The cause is named in the PR: which end event of a run the open store did not apply
- [ ] #2 An open overview, queue and live agent view drop a run from RUNNING within 5 s of the stream's event that ends it, also when the run ends through a merge after a test pass, shown by a store test fed that event sequence
- [ ] #3 The checklist names a story by its id (TASK-19 style), never by its internal key, and shows the test reply's shell line, shown by a TUI test
<!-- AC:END -->
