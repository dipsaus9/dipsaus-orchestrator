---
id: DIPO-442
title: Merge the base into a running story only when git reports a conflict
status: Refined
assignee: []
created_date: '2026-11-04 12:24'
updated_date: '2026-11-04 13:59'
labels:
  - 'tier:M'
milestone: m-2
dependencies: []
references:
  - packages/engine/src/box/collisions.ts
  - packages/engine/src/run/conflicts.ts
  - packages/engine/src/run/box-runs.ts
  - packages/engine/test/box/collisions.test.ts
  - packages/engine/test/run/conflicts.test.ts
  - packages/engine/test/create/box-runs.test.ts
  - docs/decisions/0002-review-and-testing.md
  - docs/decisions/0008-worker-adapter.md
priority: medium
type: chore
ordinal: 415000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want dipo to merge the base branch into a running story only when git reports a conflict, so that stories make fewer needless merges and CI rounds, as the review and worker decisions already say.

Maintainer's decision, planning interview 2026-11-04 (drift item C16). Does not block M2.

0002 and 0008 say the base is merged into a story only on a conflict. The code also merges without a conflict in three places:
- The collisions poll catch-up in "overlap" mode merges when base and story changed the same paths (#maybeCatchUp and planCatchUp in packages/engine/src/box/collisions.ts).
- The sync at done uses "always" for riskier stories, tier L or test-before-merge (#riskier in packages/engine/src/run/conflicts.ts).
- mergeOnResume, run when a story parked for a conflict is resumed, merges whenever the base moved (collisions.ts and packages/engine/src/run/box-runs.ts).

What goes, about 300 lines: those three paths, the clean-merge notice and message texts, and the carried approvals that exist only for clean merges dipo made (approvalCarries and #carry in conflicts.ts). What stays: merge-tree planning, the conflict catch-up and its unwritable park, staging into the box, the catch_ups records, the marker check at done, the In Review conflict check and the conflict resumes. The plan mode "always" of syncInTurn is merge-tree planning and stays. The overlap notices to the worker and the maintainer stay as information only (maintainer's decision, 2026-11-04; 0008).

Built by builder agents: it changes dipo's own run path.

```dipo
branch: "DIPO-442/base-merge-only-on-conflict"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) collisions.test.ts: base and story changing the same paths without a conflict causes no merge; a real conflict still starts the catch-up"
    - kind: "automated"
      check: "(unit) conflicts.test.ts: a tier L or test-before-merge story whose base moved without a conflict is not merged at done"
    - kind: "automated"
      check: "(unit) box-runs.test.ts: a resume after the base moved without a conflict merges nothing; with a conflict it merges as before"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The collisions poll merges the base into a story only when merge-tree reports a conflict, never for overlapping paths alone
- [ ] #2 The sync at done treats every story the same: the always mode for tier L and test-before-merge stories is removed
- [ ] #3 Resuming a story parked for a conflict merges the base only when merge-tree still reports a conflict, not whenever the base moved
- [ ] #4 The overlap notices to the worker and the maintainer stay, as information only: dipo takes no action on them
- [ ] #5 The carried approvals and the clean-merge notice and message texts are removed with the paths that used them
- [ ] #6 The conflict path works as before: its tests for the catch-up, the unwritable park, the marker check and the In Review conflict check pass
- [ ] #7 ADRs 0002 and 0008 still describe what runs, and only one of them states the only-on-conflict rule
<!-- AC:END -->
