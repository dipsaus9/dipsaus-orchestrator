---
id: DIPO-415
title: Show the whole desk command and no lost health between sessions
status: Done
assignee: []
created_date: '2026-11-01 15:39'
updated_date: '2026-11-01 16:53'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/overview/desk.ts
  - packages/engine/test/overview/desk.test.ts
  - packages/engine/src/views/work.ts
  - packages/engine/test/views/
modified_files:
  - packages/engine/src/overview/desk.ts
  - packages/engine/src/records/run-records.ts
  - packages/engine/src/views/work.ts
  - packages/engine/test/overview/desk.test.ts
  - packages/engine/test/views/derive.test.ts
priority: low
type: bug
ordinal: 393000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: what the desk and `dipo watch` show can be acted on as read: commands appear whole, and a run moving from developer to reviewer does not look lost.

Found in the M1 hand-test wave of 2026-11-01 on the scratch office (binary 9c7d41238fbc). The desk detail of a merge gate was cut mid-command: "or reject with `dipo rejec…`". The text comes from packages/engine/src/run-state/gates.ts; the engine cuts every detail at `DESK_DETAIL_MAX` (300) with "…" (packages/engine/src/overview/desk.ts, about lines 263 and 281). `dipo watch` briefly showed "health LOST !!" between the developer session's end and the reviewer's start: packages/engine/src/views/work.ts derives `exitUnprocessed` (about line 185) as true in that gap. 0009.

```dipo
branch: "DIPO-415/desk-and-watch-text"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a desk detail is never cut inside a backticked command, and a run between its developer's end and its reviewer's start is not derived as lost"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A desk detail longer than `DESK_DETAIL_MAX` is cut before a backticked command or after its closing backtick, never inside one, shown by a test with the merge-gate text from run-state/gates.ts
- [x] #2 Between a developer session's end and the reviewer session's start, a run's health is not derived as lost, while a developer exit the engine has not processed still is, shown by a test of `deriveHealth`'s facts
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-01 16:53 UTC
- Criteria met: 2 of 2 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 1, failed 0
- Budget used: 81,397 of 300,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 0
<!-- SECTION:FINAL_SUMMARY:END -->
