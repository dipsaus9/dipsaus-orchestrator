---
id: DIPO-226
title: Retry the done-on-base release once when the base moved during reconcile
status: Done
assignee: []
created_date: '2026-10-19 23:02'
updated_date: '2026-10-20 10:07'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/reconcile/done-on-base.ts
  - packages/engine/src/reconcile/reconcile.ts
  - packages/engine/test/reconcile/done-on-base.test.ts
priority: low
type: enhancement
ordinal: 226000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a claim of a story Done on _base that reconcile skips because _base moved since its index pass is tried again in the same reconcile after one reindex, instead of waiting without a word for the next rescan.

Context: review of DIPO-216 (PR #240). releaseOne in packages/engine/src/reconcile/done-on-base.ts reads the HEAD of _base inside the git queue item and returns skipped when it is not the pass's commit, with no notice; releaseDoneOnBase counts only releases, and reconcile (packages/engine/src/reconcile/reconcile.ts, step 1b) reindexes only when one was released. The skipped claim keeps its claim, worktree and port slot until the next rescan. Reconcile has no logger; it reports through engine.notice findings, and a notice for each skip would repeat at every rescan, so this story retries once instead. A claim skipped because its run was reopened stays skipped, as today. DIPO-162 handles the rest of a story finished elsewhere; this story stays separate from it.

```dipo
branch: "DIPO-226/done-on-base-retry-moved-base"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) releaseDoneOnBase returns its released count and the count of claims skipped because _base HEAD was not the pass's commit"
    - kind: "automated"
      check: "(integration, real git) _base moves between the index pass and the git queue item; the claim is released in the same reconcile after one reindex"
    - kind: "automated"
      check: "(integration, real git) _base moves again after the reindex; reconcile retries once only, keeps the claim and writes no notice for it"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 releaseDoneOnBase in packages/engine/src/reconcile/done-on-base.ts returns the number of claims it released and the number it skipped because the HEAD of _base was not the pass's commit
- [x] #2 When that skip count is above zero, reconcile in packages/engine/src/reconcile/reconcile.ts reindexes and runs the done-on-base step once more with the new pass; a claim skipped again keeps its claim, worktree and slot for the next rescan with no notice
- [x] #3 Tests in packages/engine/test/reconcile/done-on-base.test.ts move _base between the index pass and the git queue item and show the claim released in the same reconcile after one reindex, and show one retry only when _base moves again
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M5CBSZSZHXVN5TVVBABXNQ9Q (Haiku, 20 turns, about $0.03, 4 min) reported done, In Review, with no denied call and no write outside the References. releaseDoneOnBase returns { released, baseMoved }; when a claim was skipped because _base moved after the index pass, reconcile reindexes once and runs the step once more, and a claim skipped again waits for the next rescan with no notice; a release still reindexes, so a retry that releases gives two reindexes. The DIPO-216 safety rules are unchanged. Review passed; advisory to the gap list: the retry rechecks every live claim, so a dirty or foreign-locked claim in the same pass gets its kept notice twice. Verify outside the sandbox: exit 0, 3962 tests; DIPO_TEST_CI=1 reconcile and daemon tests pass (259).
<!-- SECTION:NOTES:END -->
