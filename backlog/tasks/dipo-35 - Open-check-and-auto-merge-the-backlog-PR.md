---
id: DIPO-35
title: Open and check the backlog PR
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 09:29'
labels:
  - 'tier:M'
  - test-before-merge
milestone: m-0
dependencies:
  - DIPO-34
  - DIPO-38
  - DIPO-71
references:
  - packages/engine/src/backlog/pr/
  - packages/engine/src/platform/host.ts
  - packages/engine/test/backlog/pr/
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
Outcome: the engine opens or updates one backlog-only PR per office for the open `dipo/backlog-*` branch through `gh`, runs the code-only structural check on it whenever it changes and after a hand merge, and reports the stories a failed check blocks.

Context: added by M0 breakdown decision D4 (DIPO-15): in M0 the engine opens and auto-merges backlog-lane PRs, as 0010 decided. Merging through the merge slot was split into DIPO-73 in the M0 review (DIPO-15). The engine reaches the host through `gh` with the maintainer's own credentials, behind the platform module, never from a worker. The check reads stored gate decisions (DIPO-71) and live claims (DIPO-38). The run skip is a predicate that DIPO-48 uses. The live test runs only when `DIPO_LIVE_REPO` names a scratch GitHub repository and is skipped otherwise, because the end-to-end path through `dipo office init` needs DIPO-36, which comes after this story. References: 0010 section 2 (lane b: one backlog-only PR per office, structural check rules, check before merge and after a hand merge), open question 1 (auto-merge after the check); 0016 rule 1 (PR title grammar, scope `backlog`); 0002 amendment (backlog-only PRs auto-merge without the reviewer agent); 0008 section 2 (engine runs `gh` outside the sandbox).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

```dipo
branch: "DIPO-35/open-check-auto-merge-backlog-pr"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) structural check over fixture diffs: a non-`backlog/` path, an unparsable task, a disallowed transition, a new Ready without a matching gate decision and a touched claimed task each fail with their rule; a valid init diff passes."
    - kind: "automated"
      check: "(engine) with a fake host, a pushed branch opens one PR; a second operation updates the same PR; a failing check keeps it open with a notice."
    - kind: "automated"
      check: "(engine) a hand merge with a failing check emits a notice and `backlogCheckBlocked` reports the affected story."
    - kind: "automated"
      check: "(unit) `gh --version` below the minimum is refused with a notice naming the version."
    - kind: "manual"
      check: "create a scratch GitHub repository with this repository's `ci.yml` and `pr-title.yml` and the required checks `ci-ok` and `pr-title`, then run `DIPO_LIVE_REPO=<owner>/<name> bun test packages/engine/test/backlog/pr/live.test.ts`"
      expect: "a `chore(backlog): ...` PR opens on the scratch repository, `pr-title` goes green, and the test reports the structural check as passed."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `platform/host.ts` is the only code that runs `gh`; it creates, updates, reads, closes and squash-merges a PR and reads its required check states.
- [ ] #2 `platform/host.ts` checks `gh --version` against a minimum version constant, the oldest release with every `gh` subcommand and flag the engine uses, and refuses below it with a notice naming the version.
- [ ] #3 After a push of the open engine branch, the engine opens a PR titled `chore(backlog): <summary>` that passes `scripts/check-pr-title.ts`, or updates the office's one open backlog PR; the PR ref is stored on the journal entries.
- [ ] #4 The structural check is pure code over the PR diff and the stored facts: only `backlog/` paths change, every changed task parses (R02), each status change is an allowed 0012 transition, each new `Ready` matches a passing gate decision stored for that task's content hash (DIPO-71), and no task with a live claim (DIPO-38) is touched.
- [ ] #5 The check runs when the PR is opened or updated; a failure keeps the PR open, emits an `engine.notice` naming the rule and the task, and marks the PR as not mergeable for DIPO-73.
- [ ] #6 A backlog PR the engine opened that is merged by hand is checked again right after the merge is seen; a failure is a notice, and `backlogCheckBlocked(office, key)` reports the affected stories until a new backlog PR fixes them, for `work.run` (DIPO-48) to skip them.
- [ ] #7 Without a remote or without `gh` authenticated, no PR is opened and the engine reports the branch that is waiting.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S19b (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
