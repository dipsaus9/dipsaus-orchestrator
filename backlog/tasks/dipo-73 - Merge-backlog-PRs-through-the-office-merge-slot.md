---
id: DIPO-73
title: Merge backlog PRs through the office merge slot
status: To Do
assignee: []
created_date: '2026-10-12 09:21'
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

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

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
- [ ] #1 The merge slot holds one PR per office: it merges `origin/<base>` into the branch unless already contained, pushes once without force, waits for `ci-ok` and `pr-title`, re-runs the DIPO-35 structural check, then squash-merges.
- [ ] #2 A host refusal because the base moved repeats from the merge step at most 3 times, then leaves the PR open with an `engine.notice`.
- [ ] #3 A merge of `origin/<base>` that conflicts aborts and rebuilds the branch from the journal (DIPO-34); the rebuild pushes a new branch name, opens a new PR and closes the old one.
- [ ] #4 While a backlog PR is in the slot, new lane-b operations are held and go to the next backlog PR, or onto the branch after the merge.
- [ ] #5 After the merge the journal entries are marked merged, and `pendingLaneOp` (DIPO-34) stops reporting their stories.
- [ ] #6 Check states are polled every `polling.prStateSeconds` from office configuration.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Split from DIPO-35 in the M0 review (DIPO-15); carries DIPO-35's test-before-merge flag for the merge. Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
