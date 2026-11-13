---
id: DIPO-503
title: A design or docs run parks when a part changes a file outside its kind's area
status: Refined
assignee: []
created_date: '2026-11-13 13:08'
updated_date: '2026-11-13 13:08'
labels:
  - 'tier:M'
milestone: m-4
dependencies:
  - DIPO-477
  - DIPO-500
  - DIPO-502
references:
  - packages/engine/src/box/parts.ts
  - packages/engine/src/create/runs.ts
  - packages/engine/src/run/work-run.ts
  - packages/engine/src/roles/area.ts
  - packages/engine/src/db/migrations/
  - packages/engine/test/box/parts.test.ts
  - packages/engine/test/run/parts-commit.test.ts
  - docs/decisions/0008-worker-adapter.md
type: feature
ordinal: 474000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want a design or docs run to park when it changes a file its kind may not write so that a designer or a docs writer never lands code or decision changes.

DIPO-477 stores the run's role (name, instructions, model, effort) with the run at start. DIPO-500 gives each role a kind: code, design or docs. DIPO-502 adds the area module (packages/engine/src/roles/area.ts), which answers whether a path is in a kind's area for a story id, and R24 uses it to keep a design or docs story's references in that area. Nothing checks what a run actually writes. Each part goes through the protected-file check and the secret scan only (packages/engine/src/box/parts.ts:1739-1767). The maintainer decided (planning 2026-11-13) that a design run changing a file outside docs/design/<ID>/ parks, and that the park reuses scope-violation.

Scope:
- Run start: the role's kind is stored with the role DIPO-477 stores, in the same start transaction. A run with no stored role, or a stored role without a kind, is a code run.
- PartRun (parts.ts:958) gains the run's kind. It is filled where the deliverer builds it (packages/engine/src/create/runs.ts:739-747 and 1383-1390).
- The scan: for a design or docs run, after the protected-file check and before the secret scan, every added, changed and deleted path of the part is checked with the area module for the run's kind and story id. One path outside the area is a hit: PART_HITS (parts.ts:218) gains an outside-area hit, nothing is committed or pushed, and the story parks scope-violation through partPark (parts.ts:1056).
- The park detail is fixed text that names the kind and its area and never a path, as protectedDetail does (parts.ts:628). The paths go to the run directory's record only (#hitRecord, parts.ts:1821).
- Every part is checked, the last part at done too (finishLast).
- The part is compared with the last delivered tree, the story branch's tip, so base changes that dipo merged onto the branch are not part changes and do not hit.
- A code run is unchanged.

scope-violation is not resumable (packages/engine/src/records/resume-policy.ts:65): the maintainer discards the run, as for a protected-file hit. Amend 0008, where it lists the part scans.

```dipo
branch: "DIPO-503/design-docs-run-parks-when-part-changes"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "A design run of DIPO-9 commits a part that changes docs/design/DIPO-9/a.md and parks scope-violation on a part that changes packages/a.ts, with nothing committed or pushed"
    - kind: "automated"
      check: "A docs run parks scope-violation on a part that changes docs/decisions/0001-x.md and commits one that changes README.md"
    - kind: "automated"
      check: "The outside-area park detail names the kind and its area and holds no path, and the run directory's record holds the path that hit"
    - kind: "automated"
      check: "A design run whose last part at done changes a file outside its area parks and does not move the story to In Review"
    - kind: "automated"
      check: "A code run and a run with no stored kind commit a part that changes packages/a.ts as before"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A design run whose part changes only files under docs/design/<ID>/ of its own story commits the part.
- [ ] #2 A design run whose part adds, changes or deletes a file outside docs/design/<ID>/ commits and pushes nothing and parks scope-violation.
- [ ] #3 A docs run whose part changes a file outside the docs area of DIPO-502 commits and pushes nothing and parks scope-violation.
- [ ] #4 The park detail of an outside-area hit names the run's kind and its area and holds no path; the run directory's record holds the paths.
- [ ] #5 The last part at done gets the same check, and an outside-area hit there parks instead of moving the story to In Review.
- [ ] #6 A code run, a run started before this change and a run whose stored role has no kind deliver parts exactly as before.
- [ ] #7 A part after dipo merged base changes outside the area onto the story branch does not hit for those base changes.
- [ ] #8 Decision 0008 lists the area check among the part scans and says it parks scope-violation.
<!-- AC:END -->
