---
id: DIPO-298
title: Stop the image builder again after building a box image
status: To Do
assignee: []
created_date: '2026-10-22 08:30'
updated_date: '2026-10-22 08:32'
labels:
  - 'tier:S'
  - box
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/box/image.ts
  - packages/engine/test/box/image.test.ts
priority: high
type: bug
ordinal: 287000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: after dipo builds a box image, the container image builder it started is stopped again, so it does not keep two CPUs and 2 GB of memory after the build.

Context: in the first box run (DIPO-275 on DIPO-248, run run_01M5H7RZ4HT6ZE49074MCH9EWF, 2026-10-22) the builder box (buildkit, 2 CPUs, 2048 MB) was still running after the image build and after the run ended.

```dipo
branch: "DIPO-298/stop-image-builder"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 dipo stops the builder after a build it started, whether the build passed or failed
- [ ] #2 A builder that was already running before the build is left running
- [ ] #3 Tests with a fake Spawn cover the three cases
<!-- AC:END -->
