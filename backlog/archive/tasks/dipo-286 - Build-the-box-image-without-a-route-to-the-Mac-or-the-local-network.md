---
id: DIPO-286
title: Build the box image without a route to the Mac or the local network
status: To Do
assignee: []
created_date: '2026-10-21 15:23'
updated_date: '2026-10-22 18:16'
labels:
  - box
  - cutover
  - needs-refinement
milestone: m-1
dependencies:
  - DIPO-275
  - DIPO-294
  - DIPO-298
references:
  - packages/engine/src/box/image.ts
  - docs/decisions/0021-worker-isolation.md
type: feature
ordinal: 275000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the box image is built where its install scripts have no route to the Mac, the local network or the registries except through dipo's proxies, closing the build-time risk the 0021 amendment of 2026-10-21 (DIPO-266) accepts.

Context: `container build` has no network option, so today's build runs on Apple container's default network. Options to weigh in refinement: build inside a box on the host-only network and turn it into an image, or install without lifecycle scripts and run only trusted steps.

```dipo
branch: "DIPO-286/closed-image-build"
unknowns:
  - q: "Build inside a box on the host-only network and turn it into an image, or install without lifecycle scripts and run only trusted steps?"
    status: "open"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 During an image build, no install step can reach the Mac, the local network or a registry except through dipo's proxies, shown by a real-box build test
- [ ] #2 docs/decisions/0021-worker-isolation.md gets a dated amendment that closes the build-time risk
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-22: combined into DIPO-281 (maintainer, M1 speed-up)
<!-- SECTION:NOTES:END -->
