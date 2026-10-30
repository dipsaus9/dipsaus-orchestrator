---
id: DIPO-365
title: Pass or fail a story's test from the TUI checklist view
status: Done
assignee: []
created_date: '2026-10-28 13:44'
updated_date: '2026-10-30 08:32'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-309
  - DIPO-351
references:
  - packages/tui/src/
modified_files:
  - packages/tui/src/actions.ts
  - packages/tui/src/app.tsx
  - packages/tui/src/checklist.test.tsx
  - packages/tui/src/checklist.tsx
  - packages/tui/src/keys.ts
priority: medium
type: feature
ordinal: 345000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the TUI checklist view 4 shows a story's manual test steps beside its running test, and the maintainer passes or fails the test from it.

Split from DIPO-309 (its criterion 9), which shipped dipo test in the engine, daemon and CLI with the Mac loopback forwarder. 0009 (checklist view 4, the desk TEST row, keys t, P and F; a fail needs a note). The P and F keys belong to view 4 only, since P on the desk parks a story (DIPO-344).

```dipo
branch: "DIPO-365/tui-test-checklist"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit, TUI harness) view 4 shows the steps, P sends a pass, F pre-fills the note with the first unticked step and sends a fail, and Esc leaves the test open"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The TUI checklist view `4` (and `t` on a desk row) shows the steps with local ticks, `P` passes, `F` fails with the note pre-filled with the first unticked step, and Esc leaves the test open
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-10-30 08:32 UTC
- Criteria met: 1 of 1 (as the worker reported them)
- Loops: 0; CI attempts: 1
- Review rounds: 2, failed 0
- Budget used: 174,069 of 300,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 0
<!-- SECTION:FINAL_SUMMARY:END -->
