---
id: DIPO-35
title: 'Open, check and auto-merge the backlog PR'
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 07:58'
labels:
  - 'tier:M'
  - test-before-merge
milestone: m-0
dependencies:
  - DIPO-30
  - DIPO-34
references:
  - packages/engine/src/backlog/pr/
  - packages/engine/src/merge-slot/
  - packages/engine/src/platform/host.ts
  - packages/engine/src/db/migrations/
  - packages/engine/test/backlog/pr/
  - packages/engine/test/merge-slot/
documentation:
  - docs/decisions/0002-review-and-testing.md
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0010-backlog-and-git-integration.md
  - docs/decisions/0012-story-standard.md
  - docs/decisions/0016-ci-release-and-versioning.md
priority: high
type: feature
ordinal: 35000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine opens or updates one backlog-only PR per office for the open `dipo/backlog-*` branch, runs the code-only structural check on it, and merges it through the office's merge slot once the check and the required CI checks are green, with no reviewer agent.

Context: added by M0 breakdown decision D4 (DIPO-15): in M0 the engine opens and auto-merges backlog-lane PRs, as 0010 decided. The merge slot here serves backlog PRs only; story PRs use it from M1 (M0 breakdown decision D1, DIPO-15). The engine reaches the host through `gh` with the maintainer's own credentials, behind the platform module, never from a worker. References: 0010 section 2 (lane b: one backlog-only PR per office, structural check rules, check before merge and after a hand merge, rebuild closes the old PR), section 7 (Merge slot row, failure case "Backlog PR conflicts or is rejected"), open question 1 (auto-merge after the check); 0016 rule 1 (PR title grammar, scope `backlog`), rule 2 (required checks, merge slot steps, lane-b PRs in the slot, held operations); 0002 amendment (backlog-only PRs auto-merge without the reviewer agent); 0008 section 2 (engine runs `gh` outside the sandbox).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

```dipo
branch: "DIPO-35/open-check-auto-merge-backlog-pr"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) structural check over fixture diffs: a non-`backlog/` path, an unparsable task, a disallowed transition, a new Ready without a matching gate decision and a touched claimed task each fail with their rule; a valid init diff passes."
    - kind: "automated"
      check: "(engine) with a fake host, a pushed branch opens one PR; a second operation updates the same PR; green checks lead to one squash merge and the journal entries become merged."
    - kind: "automated"
      check: "(engine) a fake host that refuses the merge three times leaves the PR open with a notice; a conflicting base rebuilds on a new branch, opens a new PR and closes the old one."
    - kind: "automated"
      check: "(engine) a hand merge with a failing check emits a notice and `run` skips the affected story."
    - kind: "manual"
      check: "create a scratch GitHub repository with this repository's `ci.yml` and `pr-title.yml` and the required checks `ci-ok` and `pr-title`, clone it, run `dipo office open` in the clone, then `dipo office init`"
      expect: "a `chore(backlog): ...` PR opens, `ci-ok` and `pr-title` go green, and the engine squash-merges it without a reviewer."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `platform/host.ts` is the only code that runs `gh`; it creates, updates, reads, closes and squash-merges a PR and reads its required check states.
- [ ] #2 After a push of the open engine branch, the engine opens a PR titled `chore(backlog): <summary>` that passes `scripts/check-pr-title.ts`, or updates the office's one open backlog PR; the PR ref is stored on the journal entries.
- [ ] #3 The structural check is pure code over the PR diff and the stored facts: only `backlog/` paths change, every changed task parses (R02), each status change is an allowed 0012 transition, each new `Ready` matches a passing gate decision stored for that task's content hash, and no task with a live claim is touched.
- [ ] #4 The check runs when the PR is opened or updated and again immediately before the merge; a failure keeps the PR open, emits an `engine.notice` naming the rule and the task, and blocks the merge.
- [ ] #5 The merge slot holds one PR per office: it merges `origin/<base>` into the branch unless already contained, pushes once without force, waits for `ci-ok` and `pr-title`, re-runs the check, then squash-merges; a host refusal because the base moved repeats from the merge step at most 3 times, then leaves the PR open with a notice.
- [ ] #6 A merge of `origin/<base>` that conflicts aborts and rebuilds the branch from the journal (DIPO-34); a rebuild pushes a new branch name, opens a new PR and closes the old one.
- [ ] #7 While a backlog PR is in the slot, new lane-b operations are held and go to the next backlog PR, or onto the branch after the merge.
- [ ] #8 A backlog PR the engine opened that is merged by hand is checked again right after the merge is seen; a failure is a notice, and the affected stories are skipped by `run` until a new backlog PR fixes them.
- [ ] #9 After the merge the journal entries are marked merged and the pending-op skip for their stories ends.
- [ ] #10 Without a remote or without `gh` authenticated, no PR is opened and the engine reports the branch that is waiting.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S19b (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
