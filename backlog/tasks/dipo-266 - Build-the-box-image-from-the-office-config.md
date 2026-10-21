---
id: DIPO-266
title: Build the box image from the office config
status: In Review
assignee: []
created_date: '2026-10-21 13:44'
updated_date: '2026-10-21 15:13'
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
  - packages/engine/src/box/apple-args.ts
  - packages/engine/src/box/apple-container.ts
  - packages/engine/src/box/port.ts
  - packages/engine/src/box/index.ts
  - packages/engine/test/box/args.test.ts
  - packages/engine/test/box/real-box.box.test.ts
  - packages/engine/src/config/load.ts
  - packages/engine/src/config/index.ts
  - packages/engine/schema/office.schema.json
  - packages/engine/test/office/load.test.ts
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
- [x] #1 A new box section in the office config (a new config version) describes the image, and dipo reads it from the base branch, so a story cannot change it
- [x] #2 dipo writes the build file itself from that description and builds with container build; a build file inside the repository is never used
- [x] #3 The image tag is a hash of the description: an unchanged description reuses the image, a changed one builds a new one
- [x] #4 A default is detected from the repository scan (the Bun version from .bun-version, the package manager), so a new office needs no hand-written box section
- [x] #5 Unit tests cover the build file and the hash; the real build runs in the opt-in real-box test
- [x] #6 Claude Code is installed from npm through Safe-Chain at the pinned version, with its auto-update and nonessential traffic turned off in the image (0021 section 4)
- [x] #7 The box section lists the files outside git that a box may get (0021 decision 9), each marked as holding no real secrets; an entry without that mark is refused when the config is read
<!-- AC:END -->
