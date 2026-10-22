---
id: DIPO-295
title: Fill the package cache before a box run and mount it in the box
status: To Do
assignee: []
created_date: '2026-10-22 08:30'
updated_date: '2026-10-22 08:32'
labels:
  - 'tier:M'
  - box
  - cutover
milestone: m-1
dependencies:
  - DIPO-294
references:
  - packages/daemon/src/runs.ts
  - packages/engine/src/box/cache.ts
  - packages/engine/src/box/workers.ts
  - packages/daemon/test/unit/box-runs.test.ts
priority: high
type: feature
ordinal: 284000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: before a story's box starts, dipo fills or reuses the office's package cache in a fill box and mounts it read-only in the story's box, so installs in the box take cached packages without the web.

Context: DIPO-267 built the fill and the read-only mount, and BoxWorkers takes a packageCache dependency, but the daemon never supplies it (packages/daemon/src/runs.ts). In the first box run (DIPO-275 on DIPO-248, run run_01M5H7RZ4HT6ZE49074MCH9EWF, 2026-10-22) no cache was filled and bun install went through the web proxy. DIPO-275 criterion 4 needs the fill to run live. A fill failure is not a reason to stop the story: the cache only saves downloads.

```dipo
branch: "DIPO-295/wire-box-package-cache"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The daemon supplies the package cache to box runs: fill or reuse it by lockfile and package manager version before the story's box starts, and mount it read-only
- [ ] #2 A fill that fails, or a lockfile the cache does not support, lets the run go on without a cache and shows a notice on the run with the reason
- [ ] #3 Tests with a fake box backend cover fill, reuse, failure and an unsupported lockfile
<!-- AC:END -->
