---
id: DIPO-288
title: 'Support Yarn, bun.lockb and pnpm catalogs in the box package cache'
status: To Do
assignee: []
created_date: '2026-10-21 17:40'
updated_date: '2026-10-21 17:42'
labels:
  - box
  - needs-refinement
milestone: m-1
dependencies:
  - DIPO-273
references:
  - packages/engine/src/box/cache.ts
  - packages/engine/src/box/cache-input.ts
  - packages/engine/test/box/cache-input.test.ts
type: feature
ordinal: 277000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: offices whose lockfile dipo's box cache refuses today get a working package cache: Yarn, Bun's binary bun.lockb, and pnpm workspaces that use catalogs.

Context: DIPO-267 refuses these with box.cacheUnsupported, so such an office gets no box (0021 section 5).

```dipo
branch: "DIPO-288/more-cache-formats"
unknowns:
  - q: "How does dipo read the binary bun.lockb and Yarn's lockfile formats so the input checks of DIPO-267 still hold?"
    status: "open"
  - q: "How are pnpm catalog entries checked, given they name versions outside the lockfile's packages?"
    status: "open"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A Yarn, bun.lockb or catalog-using pnpm office fills its cache in a fill box and its boxes install offline from it
- [ ] #2 The input checks of DIPO-267 cover each new format, so no lockfile entry fetches outside the Safe-Chain registries
<!-- AC:END -->
