---
id: DIPO-266
title: Build the box image from the office config
status: Refined
assignee: []
created_date: '2026-10-21 13:44'
updated_date: '2026-10-21 13:53'
labels:
  - 'tier:M'
  - cutover
  - box
milestone: m-1
dependencies:
  - DIPO-265
references:
  - packages/engine/src/box/image.ts
  - packages/engine/src/config/schema.ts
  - packages/engine/src/scan/detect/
  - packages/engine/test/box/image.test.ts
  - packages/engine/test/config/
priority: high
type: feature
ordinal: 255000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the office config describes a box's image (a Debian slim base, the toolchain and its versions, extra system packages and a pinned Claude Code version), and dipo builds it once with container build and rebuilds only when the description changes.

Context: Decision 0021 (worker isolation, DIPO-263) and the probe results of DIPO-264 (tools/box-probe/RESULTS.md and the 0021 amendment of 2026-10-21).

```dipo
branch: "DIPO-266/box-image"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A new box section in the office config (a new config version) describes the image, and dipo reads it from the base branch, so a story cannot change it
- [ ] #2 dipo writes the build file itself from that description and builds with container build; a build file inside the repository is never used
- [ ] #3 The image tag is a hash of the description: an unchanged description reuses the image, a changed one builds a new one
- [ ] #4 A default is detected from the repository scan (the Bun version from .bun-version, the package manager), so a new office needs no hand-written box section
- [ ] #5 Unit tests cover the build file and the hash; the real build runs in the opt-in real-box test
- [ ] #6 Claude Code is installed from npm through Safe-Chain at the pinned version, with its auto-update and nonessential traffic turned off in the image (0021 section 4)
- [ ] #7 The box section lists the files outside git that a box may get (0021 decision 9), each marked as holding no real secrets; an entry without that mark is refused when the config is read
<!-- AC:END -->
