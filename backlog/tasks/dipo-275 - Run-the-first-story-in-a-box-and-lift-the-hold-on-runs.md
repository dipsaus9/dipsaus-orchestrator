---
id: DIPO-275
title: Run the first story in a box and lift the hold on runs
status: Refined
assignee: []
created_date: '2026-10-21 13:44'
updated_date: '2026-10-22 14:27'
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
  - DIPO-293
  - DIPO-294
  - DIPO-295
  - DIPO-299
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
- [x] #1 One Ready story runs in a box: parts delivered and committed, verify green, review round run
- [x] #2 A gap report of the run is written, and every gap is filed
- [x] #3 docs/decisions/0021-worker-isolation.md gets a dated amendment with the run's result and whether the hold is lifted
- [ ] #4 The run covers the box image build through the build proxy and the package cache fill in a fill box, and records in the gap report whether the cache stream arrived intact and whether the managers' caches held any link
- [ ] #5 The run's reviewer session shows, in its system/init and in a Read outside the copy, that no skills, plugins or settings from the read-only copy loaded and that reads outside the copy are refused, and that its reads of the copy work
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Result of 2026-10-22: the first box run (DIPO-248) parked verify-failing because the box has no git program; the same day the maintainer redesigned verify (0021 amendment: dipo installs the packages in the box, the worker runs verify itself, CI on dipo's story PR is the verify). The retest ran DIPO-300 (run run_01M5HS75YC89DVXQAEMFFT01P5) and DIPO-122 (run run_01M5HY626T0A2FGPR3SEK1ERKY) end to end with green CI; the maintainer lifted the hold for box runs. Still open: criterion 4's package cache fill (needs DIPO-295; the image build through the build proxy was shown in the first run) and criterion 5's refused read outside the reviewer's copy (the reviewer's system/init showed read-only tools, no skills, no MCP and only built-in plugins, and its reads of the copy worked, but it never tried a read outside). Gaps filed: DIPO-301 to DIPO-307.
<!-- SECTION:NOTES:END -->
