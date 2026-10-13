---
id: DIPO-73
title: Merge backlog PRs through the office merge slot
status: In Progress
assignee:
  - '@claude'
created_date: '2026-10-12 09:21'
updated_date: '2026-10-13 13:48'
labels:
  - 'tier:M'
  - test-before-merge
milestone: m-0
dependencies:
  - DIPO-35
references:
  - packages/engine/src/merge-slot/
  - packages/engine/test/merge-slot/
documentation:
  - docs/decisions/0002-review-and-testing.md
  - docs/decisions/0010-backlog-and-git-integration.md
  - docs/decisions/0016-ci-release-and-versioning.md
priority: high
type: feature
ordinal: 35500
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine merges the office's backlog PR through a merge slot once its structural check and the required checks `ci-ok` and `pr-title` are green, retries a merge refused because the base moved, rebuilds a conflicting branch from the journal, and holds new lane-b operations while a PR is in the slot.

Context: split from DIPO-35 in the M0 review (DIPO-15); DIPO-35 keeps opening, updating and checking the PR. In M0 the engine opens and auto-merges backlog-lane PRs with no reviewer agent (M0 breakdown decision D4, DIPO-15). The merge slot serves backlog PRs only; story PRs use it from M1 (M0 breakdown decision D1, DIPO-15). The live test runs only when `DIPO_LIVE_REPO` names a scratch GitHub repository and is skipped otherwise. References: 0010 section 2 (lane b, rebuild closes the old PR), section 7 (Merge slot row, failure case "Backlog PR conflicts or is rejected"), open question 1; 0016 rule 2 (required checks, merge slot steps, lane-b PRs in the slot, held operations); 0002 amendment (backlog-only PRs auto-merge without the reviewer agent).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-73/merge-backlog-prs-through-office-merge"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) with a fake host, green checks lead to one squash merge and the journal entries become merged."
    - kind: "automated"
      check: "(engine) a fake host that refuses the merge three times leaves the PR open with a notice; a conflicting base rebuilds on a new branch, opens a new PR and closes the old one."
    - kind: "automated"
      check: "(engine) an operation submitted while the PR is in the slot lands on the next backlog PR."
    - kind: "manual"
      check: "create a scratch GitHub repository with this repository's `ci.yml` and `pr-title.yml` and the required checks `ci-ok` and `pr-title`, then run `DIPO_LIVE_REPO=<owner>/<name> bun test packages/engine/test/merge-slot/live.test.ts`"
      expect: "the test's backlog PR waits for `ci-ok` and `pr-title`, then the engine squash-merges it without a reviewer and the test passes."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The merge slot holds one PR per office: it merges `origin/<base>` into the branch unless already contained, pushes once without force, waits for `ci-ok` and `pr-title`, re-runs the DIPO-35 structural check, then squash-merges.
- [x] #2 A host refusal because the base moved repeats from the merge step at most 3 times, then leaves the PR open with an `engine.notice`.
- [x] #3 A merge of `origin/<base>` that conflicts aborts and rebuilds the branch from the journal (DIPO-34); the rebuild pushes a new branch name, opens a new PR and closes the old one.
- [x] #4 While a backlog PR is in the slot, new lane-b operations are held and go to the next backlog PR, or onto the branch after the merge.
- [x] #5 After the merge the journal entries are marked merged, and `pendingLaneOp` (DIPO-34) stops reporting their stories.
- [x] #6 Check states are polled every `polling.prStateSeconds` from office configuration.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Split from DIPO-35 in the M0 review (DIPO-15); carries DIPO-35's test-before-merge flag for the merge. Before cutover: built by hand-run agents.

Implementation (DIPO-73):
- `merge-slot/slot.ts`: `MergeSlot`, one slot per office, tick-based. A backlog PR whose last structural check passed enters; steps: fetch, merge `<remote>/<base>` into the branch unless contained (`merge --no-ff`, never a rebase), one push without force (only when the local tip differs from the remote's), wait for `ci-ok` and `pr-title` (and no other required check failing), `BacklogPrs.recheck` on the merged head, `squashMerge` with `--match-head-commit` and the PR title as subject. Polled every `polling.prStateSeconds` (load step `mergeSlot.watch`, config re-read each interval) and kicked after each lane flush.
- Refusal handling: after a host refusal the slot fetches; when the branch no longer contains the base, the base moved and the slot goes back to the merge step. At most `MAX_MERGE_ATTEMPTS` = 3 host merges; after the third refusal the PR stays open with the notice "base moved during merge 3 times". A refusal without a moved base is a `mergeSlot.refused` notice. Classifying by git facts, not by gh's error text. A refusal after which the host says the PR merged counts as merged.
- Conflict: the merge is aborted (`merge --abort`, reset to the old tip) and the lane flushes with `rebuild: <branch>`, which rebuilds from the journal on a new branch name; DIPO-35's flush hook closes the old PR and opens the new one.
- Hold: `OfficeLane` option `held`; while the slot holds the branch, `flush` returns `held: true` without fetch, git or the PR hook, so operations stay journaled (pending). When the slot lets go it flushes once, so they go onto a new branch and the next PR after a merge, or onto the branch when the PR left unmerged.
- After the merge: open journal entries of the branch become `merged` (`pendingLaneOp` stops reporting them), the PR record becomes merged in the same transaction (DIPO-35's sync skips it, as allowed in DIPO-35 review round 1), blocks of the stories it touched are cleared, and the branch is deleted locally and, best effort, on the remote.
- A PR that leaves unmerged (red checks, failed structural check, refusal, base moved 3 times) stays out until its head changes; one with red checks comes back once they no longer fail (a re-run). That memory is in-process only, so a daemon restart retries once more; no migration.
- Notice codes (engine.notice): `mergeSlot.entered|merged|rebuilt|baseMoved|refused|checksFailed|pushFailed|failed`. No contract change, no migration, no new office-scoped table.
- Live test (`packages/engine/test/merge-slot/live.test.ts`): reuses `DIPO_LIVE_REPO`. The scratch repository has no Bun workspace, so the test keeps a stub `.github/workflows/ci.yml` on the default branch whose `ci-ok` job always passes, pushing it once when missing (with a clear message if the push is refused). `pr-title` stays real. This keeps the story's intent: the engine waits for GitHub's required checks named `ci-ok` and `pr-title`, runs the structural check again and squash-merges without a reviewer; what `ci-ok` runs does not matter. It merges the PR (or closes it on failure) and deletes the branch.

Scope additions:
- packages/engine/src/backlog/lane/lane.ts: `held` option (flush does nothing while the slot holds the branch, reports `held`) and the `rebuild` flush option (rebuild a named open branch the slot found conflicting); needed for AC #3 and #4.
- packages/engine/src/backlog/lane/feature.ts: passes `held` through `BacklogLane`.
- packages/engine/src/backlog/pr/feature.ts: exports `repoOfUrl` so the slot reads the repository from the stored PR URL the same way.
- packages/engine/src/backlog/pr/index.ts: re-exports `repoOfUrl`.
- packages/engine/src/index.ts: exports the merge-slot module.
- packages/daemon/src/foreground.ts: wires `MergeSlot` (shared `GhHost`, `BacklogPrs.recheck`), the lane's `held` hook, a kick after each flush, the `mergeSlot.watch` load step and stop on shutdown.
- No change to packages/engine/src/platform/host.ts (DIPO-58 also edits it): the existing `squashMerge`, `requiredChecks` and `viewPr` suffice.
<!-- SECTION:NOTES:END -->
