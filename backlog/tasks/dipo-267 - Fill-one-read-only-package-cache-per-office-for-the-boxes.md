---
id: DIPO-267
title: Fill one read-only package cache per office for the boxes
status: Refined
assignee: []
created_date: '2026-10-21 13:44'
updated_date: '2026-10-21 14:41'
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
- [ ] #1 dipo fills the office's cache from the lockfile through Safe-Chain, outside any box
- [ ] #2 Boxes get the cache read-only; a worker's own installs stay inside its box
- [ ] #3 A changed lockfile refreshes the cache before the next box starts
- [ ] #4 Tests cover the refresh rule and the read-only attachment
- [ ] #5 Before a box is created, dipo resolves the cache path with realpath and refuses it unless it lies under dipo's own cache root, so a symlink cannot point the read-only mount elsewhere
<!-- AC:END -->
