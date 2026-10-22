---
id: DIPO-290
title: Close the open edges of delivering a box part
status: Refined
assignee: []
created_date: '2026-10-21 23:03'
updated_date: '2026-10-21 23:03'
labels:
  - 'tier:M'
  - box
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/box/parts.ts
  - packages/engine/src/box/ignore.ts
  - packages/engine/src/context/secrets.ts
  - packages/engine/test/box/parts.test.ts
  - packages/engine/test/run/parts-commit.test.ts
type: bug
ordinal: 279000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a box part is delivered the same way whatever the config, the file sizes or the ignore rules do mid-run, a daemon restart leaves no part stages behind, and a part that cannot be taken out parks instead of retrying forever.

Context: The build of DIPO-273 (PR #322) listed these edges as open.

```dipo
branch: "DIPO-290/part-delivery-edges"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The box.files list is recorded when the box is made and that record decides what a part leaves out, not the base config at part time
- [ ] #2 .env.example and .env.sample files are not treated as secret file names, while .env and .env.<name> still are
- [ ] #3 Leftover dipo-box-part- stage folders are swept at daemon start
- [ ] #4 A path that the part's own .gitignore un-ignores is delivered in that part, also in the last part
- [ ] #5 Anchored root ignore names such as /node_modules are used as in-box excludes too
- [ ] #6 A part that cannot be taken out parks the story after a set number of tries instead of retrying on every door read
- [ ] #7 Tests cover each case
<!-- AC:END -->
