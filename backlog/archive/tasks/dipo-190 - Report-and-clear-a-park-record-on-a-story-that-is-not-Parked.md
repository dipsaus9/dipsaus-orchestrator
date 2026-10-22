---
id: DIPO-190
title: Report and clear a park record on a story that is not Parked
status: Refined
assignee: []
created_date: '2026-10-17 20:30'
updated_date: '2026-10-22 18:16'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies:
  - DIPO-150
references:
  - packages/engine/src/reconcile/reconcile.ts
  - packages/engine/test/reconcile/
  - packages/engine/src/merge-slot/
  - packages/engine/test/merge-slot/
  - packages/engine/src/backlog/fields/
priority: medium
type: bug
ordinal: 179000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a park: block on a story that is not Parked no longer goes unnoticed: reconcile reports it instead of recording it as a park, and dipo's close-out commit removes it when it sets Done.

Context: DIPO-129 merged to main as Done with "park: reason ambiguous-spec" from its parked run still in its field block, after the maintainer finished it by hand. 0012 F16 and the 0010 section 3 field table say the park record exists only while Parked. Status Done wins (0020), but the task file states a false fact, and nothing flags it. Reconcile step 4 (reconcilePark in packages/engine/src/reconcile/reconcile.ts) records any F16 block with no open park row as a park "recorded by hand", whatever the story's status. The resume path already removes F16 (gitUnparkWriter, 0020 section 1).

The close-out commit that sets Done (0019 section 9 step 1) comes with DIPO-150, so this story depends on it. DIPO-162 releases a claim whose story is Done on the base through another branch and writes nothing to the backlog; a stale park block there gets this story's reconcile notice and stays for the maintainer to remove. DIPO-155 resumes parks and does not touch Done stories. 0007 section 6's reconcile table says, in the row for the current park state: "F16 with no DB park: record a park from Backlog with detail 'recorded by hand'", with no status condition. The narrowing in this story reads that row together with 0012 F16 and 0010 section 3, which allow F16 only while Parked: an F16 block on any other status is a stale fact, not a park. The 0007 section 6 note of 2026-10-20 (DIPO-190) says so; this story does not edit docs/decisions/.

```dipo
branch: "DIPO-190/flag-stale-park-record"
unknowns:
  - q: "0007 section 6's reconcile row says an F16 with no DB park is recorded as a park by hand, with no status condition. Does 0007 section 6 get a dated note that this applies only to a Parked story, and that an F16 block on any other status is reported as stale instead?"
    status: "resolved"
    answer: "A (maintainer, 2026-10-20): yes; the 0007 section 6 note of 2026-10-20 (DIPO-190) says an F16 park block with no database park is recorded as a park by hand only when the story's status is Parked, and on any other status reconcile reports the block as stale with a notice."
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) reconcile on a Done story with an F16 block emits the stale-park notice and writes no parks row; a Parked story with F16 and no row is recorded by hand"
    - kind: "automated"
      check: "(integration, real git) the close-out commit on a branch whose task file holds F16 sets Done and leaves no park key in the field block"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Reconcile (reconcilePark in packages/engine/src/reconcile/reconcile.ts) records a park from an F16 block with no open park row only when the story's status is Parked
- [ ] #2 For a story with an F16 block whose status is not Parked, reconcile writes no parks row and emits one warn engine.notice per pass with a new RECONCILE_NOTICES code, naming the story, its status and the park reason
- [ ] #3 The merge slot's close-out commit (DIPO-150, packages/engine/src/merge-slot/) removes the F16 block through the single field write path in the same commit that sets Done, and a test shows a task file that held F16 at close-out has no park key after it
- [ ] #4 A test replays the DIPO-129 case: a Done story with an ambiguous-spec F16 block gets the notice and no parks row, while a Parked story with F16 and no row is still recorded as a park by hand
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-22: combined into DIPO-155 (maintainer, M1 speed-up)
<!-- SECTION:NOTES:END -->
