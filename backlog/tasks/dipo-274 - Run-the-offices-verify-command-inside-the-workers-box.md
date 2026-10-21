---
id: DIPO-274
title: Run the office's verify command inside the worker's box
status: Refined
assignee: []
created_date: '2026-10-21 13:44'
updated_date: '2026-10-21 13:45'
labels:
  - 'tier:S'
  - cutover
  - box
milestone: m-1
dependencies:
  - DIPO-273
references:
  - packages/engine/src/run/verify-commit.ts
  - packages/engine/test/run/verify-in-box.test.ts
priority: high
type: feature
ordinal: 263000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: when the worker says the story is done, dipo runs the office's verify command inside the worker's box, without AI, and sends a red result back to the worker.

Context: Decision 0021 (worker isolation, DIPO-263) and the probe results of DIPO-264 (tools/box-probe/RESULTS.md and the 0021 amendment of 2026-10-21).

```dipo
branch: "DIPO-274/verify-in-box"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Verify runs in the box through the box interface, not in dipo's step sandbox on the Mac
- [ ] #2 A red verify sends its output back as the worker's next message, cleaned and cut as today
- [ ] #3 A green verify with the last part delivered moves the story to review
- [ ] #4 Tests cover the green and red paths
<!-- AC:END -->
