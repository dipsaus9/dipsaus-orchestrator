---
id: DIPO-236
title: Retry only the claims a moved base skipped in the done-on-base release
status: Refined
assignee: []
created_date: '2026-10-20 10:40'
updated_date: '2026-10-20 10:40'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/reconcile/done-on-base.ts
  - packages/engine/src/reconcile/reconcile.ts
  - packages/engine/test/reconcile/done-on-base.test.ts
priority: medium
type: bug
ordinal: 236000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: when _base moves during reconcile, the retry of the done-on-base release looks only at the claims the first pass skipped for the moved base, so a claim kept in the same reconcile for a dirty or foreign-locked worktree, or for an error, gets exactly one kept notice.

Context: DIPO-226 (PR #263). reconcileOffice in packages/engine/src/reconcile/reconcile.ts calls releaseDoneOnBase (packages/engine/src/reconcile/done-on-base.ts) and, when its result's baseMoved is above zero, reindexes and calls it again over every live claim. releaseOne writes the reconcile.doneOnBaseKept warn notice for a worktree git refuses to remove or that someone else locked, and the catch in releaseDoneOnBase writes it for an error, each time it looks at the claim. So a claim kept on the first pass, beside a claim the first pass skipped for the moved base, is looked at again by the retry and gets a second kept notice in the same reconcile. DoneOnBaseResult holds only the counts released and baseMoved; the test "returns the released count and the baseMoved count, with no notice for a skip" in packages/engine/test/reconcile/done-on-base.test.ts pins that shape. movingBase in that file moves _base before each of the first n git queue items, and a moved _base stays moved, so every later queue item of the same pass is skipped too: the test needs the move between the two claims' queue items.

```dipo
branch: "DIPO-236/retry-only-moved-claims"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) releaseDoneOnBase returns the run ids it skipped for a moved base with its counts, and with a set of run ids looks only at those claims"
    - kind: "automated"
      check: "(integration, real git) a dirty claim reached before _base moves and a clean claim skipped after the move, in one reconcile: the clean claim is released, the dirty one keeps its claim and slot, and exactly one reconcile.doneOnBaseKept notice is written, for the dirty claim's key; the test fails without the fix"
    - kind: "automated"
      check: "(integration, real git) the DIPO-226 tests pass with the new result shape, with the same reindex counts"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 releaseDoneOnBase returns, with its counts, the run ids of the claims it skipped because the HEAD of _base was not the pass's commit, and takes an optional set of run ids that limits it to those claims
- [ ] #2 The retry in reconcileOffice passes the run ids the first pass skipped, so it looks at no other claim; the reindex before the retry and the one after a retry that released stay as DIPO-226 has them
- [ ] #3 A test in packages/engine/test/reconcile/done-on-base.test.ts with two claims of Done stories, a dirty one whose queue item runs before _base moves and a clean one skipped because _base moved before its queue item, shows in one reconcile the clean claim released, the dirty claim kept with its claim and slot, and exactly one reconcile.doneOnBaseKept notice, for the dirty claim's key; the test fails without the fix
- [ ] #4 The DIPO-226 tests in done-on-base.test.ts pass with the new result shape and the same reindex counts
<!-- AC:END -->
