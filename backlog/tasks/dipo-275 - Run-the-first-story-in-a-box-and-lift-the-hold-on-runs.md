---
id: DIPO-275
title: Run the first story in a box and lift the hold on runs
status: Refined
assignee: []
created_date: '2026-10-21 13:44'
updated_date: '2026-10-21 17:40'
labels:
  - 'tier:S'
  - cutover
  - box
milestone: m-1
dependencies:
  - DIPO-267
  - DIPO-273
  - DIPO-274
  - DIPO-276
references:
  - docs/decisions/0021-worker-isolation.md
  - .dipo/office.yaml
priority: high
type: task
ordinal: 264000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: one real story runs end to end in a box with the maintainer watching, and when it holds, the hold on dipo runs of 2026-10-21 is lifted.

Context: Decision 0021 (worker isolation, DIPO-263) and the probe results of DIPO-264 (tools/box-probe/RESULTS.md and the 0021 amendment of 2026-10-21).

```dipo
branch: "DIPO-275/first-box-run"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 One Ready story runs in a box: parts delivered and committed, verify green, review round run
- [ ] #2 A gap report of the run is written, and every gap is filed
- [ ] #3 docs/decisions/0021-worker-isolation.md gets a dated amendment with the run's result and whether the hold is lifted
- [ ] #4 The run covers the box image build through the build proxy and the package cache fill in a fill box, and records in the gap report whether the cache stream arrived intact and whether the managers' caches held any link
<!-- AC:END -->
