---
id: DIPO-273
title: Commit each delivered part after a secret and protected-file scan
status: Refined
assignee: []
created_date: '2026-10-21 13:44'
updated_date: '2026-10-21 17:42'
labels:
  - 'tier:M'
  - cutover
  - box
milestone: m-1
dependencies:
  - DIPO-272
  - DIPO-270
references:
  - packages/engine/src/box/parts.ts
  - packages/engine/src/run/verify-commit.ts
  - packages/engine/src/run/story-git.ts
  - packages/engine/src/context/secrets.ts
  - packages/engine/test/box/parts.test.ts
  - packages/engine/test/run/parts-commit.test.ts
  - packages/engine/src/box/cache-extract.ts
  - packages/engine/test/box/cache-extract.test.ts
priority: high
type: feature
ordinal: 262000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: on part done, dipo takes the changes since the last part out of the box, scans them for secrets and protected files, commits them on the story branch in its own copy with the worker's message, and pushes; on story done, undelivered changes become a last part first.

Context: Decision 0021 (worker isolation, DIPO-263) and the probe results of DIPO-264 (tools/box-probe/RESULTS.md and the 0021 amendment of 2026-10-21).

```dipo
branch: "DIPO-273/deliver-in-parts"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 dipo copies the changed files out of the box and compares them with the last delivered part
- [ ] #2 A secret scan (content patterns and secret file names) and a protected-file check (the story's task file, CI workflows, dipo configuration) run before every commit; a hit stops the push and parks the story
- [ ] #3 The commit subject is the worker's message, cleaned and at most 72 characters, with a line naming the story and the part number; only dipo runs git
- [ ] #4 On story done, undelivered changes become a last part before verify
- [ ] #5 Tests cover the scan, the protected list, the message cleaning and the last-part rule
- [ ] #6 For box workers the References scope check at done and the scope-violation park are removed (0021 section 13); only the protected-file park stays, and tests show that a change outside the References commits while a protected file parks
- [ ] #7 A symlink in the changes copied out of the box is never followed and parks the story as a protected-file hit; container copy keeps symlinks as links, so a box can plant a link to a Mac path (DIPO-265 real-box run of 2026-10-21)
- [ ] #8 Each part leaves the box as a stream dipo writes itself into a file it creates (O_CREAT|O_EXCL|O_NOFOLLOW, a size cap), never with container copy; the stream helper is shared with the DIPO-267 cache fill and closes the exec's stdin, shown by a test
<!-- AC:END -->
