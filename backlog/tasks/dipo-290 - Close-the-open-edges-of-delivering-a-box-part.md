---
id: DIPO-290
title: Close the open edges of delivering a box part
status: Done
assignee: []
created_date: '2026-10-21 23:03'
updated_date: '2026-10-22 18:02'
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
  - packages/engine/src/box/workers.ts
  - packages/engine/test/box/workers.test.ts
  - packages/engine/src/box/index.ts
  - packages/daemon/src/runs.ts
  - packages/daemon/test/unit/box-runs.test.ts
  - packages/engine/src/run/verify-commit.ts
  - packages/engine/test/run/verify-in-box.test.ts
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
- [x] #1 The box.files list is recorded when the box is made and that record decides what a part leaves out, not the base config at part time
- [x] #2 .env.example and .env.sample files are not treated as secret file names, while .env and .env.<name> still are
- [x] #3 Leftover dipo-box-part- stage folders are swept at daemon start
- [x] #4 A path that the part's own .gitignore un-ignores is delivered in that part, also in the last part
- [x] #5 Anchored root ignore names such as /node_modules are used as in-box excludes too
- [x] #6 Tests cover each case
- [x] #7 A part that cannot be taken out does not park the story: dipo keeps retrying at the door's pace, the worker goes on, and one warning per failure streak tells the maintainer (maintainer, 2026-10-22); at done the last part is retried for up to two minutes before the story parks interrupted
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-22: built outside dipo (box-core fix), reviewed in three rounds. Criterion 6 was reworded to the maintainer's decision: a part dipo cannot take out never parks the story during the run (warn notice box.partStuck after 5 failed door reads and 2 minutes, box.partUnstuck when it comes out); at done the last part is retried for up to 2 minutes, then parks interrupted/build; a refused part still parks part-refused at once. Part stage folders now live in <state>/box-parts. Older daemons left dipo-box-part-* folders directly in the temp root; nothing sweeps them any more, and they are safe to remove by hand while no dipo daemon runs.
<!-- SECTION:NOTES:END -->
