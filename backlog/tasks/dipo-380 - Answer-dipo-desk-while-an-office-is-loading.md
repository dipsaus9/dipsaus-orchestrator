---
id: DIPO-380
title: Answer dipo desk while an office is loading
status: Done
assignee: []
created_date: '2026-10-29 12:45'
updated_date: '2026-10-30 19:56'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-351
references:
  - packages/engine/src/reads/
  - packages/engine/src/office/
  - packages/daemon/src/
modified_files:
  - packages/contract/schema/reads.schema.json
  - packages/contract/schema/work.schema.json
  - packages/contract/src/office.ts
  - packages/engine/src/commands/offices.ts
  - packages/engine/src/commands/registry.ts
  - packages/engine/src/office/manager.ts
  - packages/engine/src/reads/execute.test.ts
  - packages/engine/src/reads/execute.ts
  - packages/engine/src/views/desk-notify.ts
  - packages/engine/src/views/desk.ts
priority: medium
type: bug
ordinal: 360000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo desk` right after `dipo office open` answers at once, with the loading office shown as loading, instead of timing out.

Found on 2026-10-29 during the cutover (G7): `dipo desk` right after `dipo office open` of this repository timed out with 'the daemon did not answer within 10 s' while the office loaded (the leftover sweep, the image check), and worked a minute later. 0007.

```dipo
branch: "DIPO-380/desk-answers-while-office-loads"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) desk answers with an office marked loading while its load is held"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The desk read does not wait for an office's load; an office that is still loading appears on the desk as loading
- [x] #2 A test opens an office whose load is held, and `desk` answers within the read deadline with that office marked loading
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Mechanism to replace: a read for an office awaits `deps.offices.load(officeId)` (engine/src/reads/execute.ts), so the desk read waits for the whole office load (leftover sweep, image check) before it answers. That wait is removed for the desk: it answers from what is loaded and marks a loading office as loading. DIPO-320 adds read deadlines, which would turn this hang into a coded timedOut, not an answer, so the two stories are separate.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-10-30 19:56 UTC
- Criteria met: 2 of 2 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 2, failed 1
- Budget used: 124,476 of 300,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 1
<!-- SECTION:FINAL_SUMMARY:END -->
