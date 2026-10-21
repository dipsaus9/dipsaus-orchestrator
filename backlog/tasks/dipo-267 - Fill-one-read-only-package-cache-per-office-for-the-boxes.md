---
id: DIPO-267
title: Fill one read-only package cache per office for the boxes
status: In Review
assignee: []
created_date: '2026-10-21 13:44'
updated_date: '2026-10-21 16:44'
labels:
  - 'tier:S'
  - cutover
  - box
milestone: m-1
dependencies:
  - DIPO-266
references:
  - packages/engine/src/box/cache.ts
  - packages/engine/test/box/cache.test.ts
  - packages/engine/src/box/cache-input.ts
  - packages/engine/test/box/cache-input.test.ts
  - packages/engine/src/box/apple-container.ts
  - packages/engine/src/box/apple-args.ts
  - packages/engine/src/box/port.ts
  - packages/engine/src/box/image.ts
  - packages/engine/src/box/index.ts
  - packages/engine/test/box/apple-container.test.ts
  - packages/engine/test/box/real-box.box.test.ts
priority: high
type: feature
ordinal: 256000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: each office has one package cache that dipo fills from the lockfile through Safe-Chain and that boxes can read but not write, so a box starts with its packages installed and no worker can change what the next box gets.

Context: Decision 0021 (worker isolation, DIPO-263) and the probe results of DIPO-264 (tools/box-probe/RESULTS.md and the 0021 amendment of 2026-10-21).

```dipo
branch: "DIPO-267/box-package-cache"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 dipo fills the office's cache from the lockfile through Safe-Chain, outside any box
- [x] #2 Boxes get the cache read-only; a worker's own installs stay inside its box
- [x] #3 A changed lockfile refreshes the cache before the next box starts
- [x] #4 Tests cover the refresh rule and the read-only attachment
- [x] #5 Before a box is created, dipo resolves the cache path with realpath and refuses it unless it lies under dipo's own cache root, so a symlink cannot point the read-only mount elsewhere
<!-- AC:END -->
