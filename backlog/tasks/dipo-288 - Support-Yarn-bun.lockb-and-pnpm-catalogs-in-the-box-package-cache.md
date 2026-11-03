---
id: DIPO-288
title: 'Support Yarn, bun.lockb and pnpm catalogs in the box package cache'
status: Refined
assignee: []
created_date: '2026-10-21 17:40'
updated_date: '2026-11-03 09:51'
labels:
  - box
  - needs-refinement
dependencies:
  - DIPO-273
  - DIPO-295
  - DIPO-281
  - DIPO-225
references:
  - packages/engine/src/box/cache.ts
  - packages/engine/src/box/cache-input.ts
  - packages/engine/test/box/cache-input.test.ts
type: feature
ordinal: 277000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want offices that use Yarn, Bun's binary lockfile or pnpm catalogs to get a working package cache so that those projects can run in a box like any other.

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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-23 (maintainer): moved out of M1; no M1 office uses these lockfile formats (this repository uses the text bun.lock).

2026-10-23: now comes after DIPO-281 and DIPO-225 (it was a dependency of both before it moved out of M1; the order keeps their shared files apart).

2026-10-25: milestone removed (Later, no milestone yet) by #400.

2026-11-03: status To Do to Refined, so the backlog uses only the 0012 statuses. It still needs refinement (open unknowns) before it can be made Ready.
<!-- SECTION:NOTES:END -->
