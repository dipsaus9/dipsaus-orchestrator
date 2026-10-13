---
id: DIPO-35
title: Open and check the backlog PR
status: In Progress
assignee:
  - '@claude'
created_date: '2026-10-11 18:48'
updated_date: '2026-10-13 12:16'
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

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

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
- [x] #1 `platform/host.ts` is the only code that runs `gh`; it creates, updates, reads, closes and squash-merges a PR and reads its required check states.
- [x] #2 `platform/host.ts` checks `gh --version` against a minimum version constant, the oldest release with every `gh` subcommand and flag the engine uses, and refuses below it with a notice naming the version.
- [x] #3 After a push of the open engine branch, the engine opens a PR titled `chore(backlog): <summary>` that passes `scripts/check-pr-title.ts`, or updates the office's one open backlog PR; the PR ref is stored on the journal entries.
- [x] #4 The structural check is pure code over the PR diff and the stored facts: only `backlog/` paths change, every changed task parses (R02), each status change is an allowed 0012 transition, each new `Ready` matches a passing gate decision stored for that task's content hash (DIPO-71), and no task with a live claim (DIPO-38) is touched.
- [x] #5 The check runs when the PR is opened or updated; a failure keeps the PR open, emits an `engine.notice` naming the rule and the task, and marks the PR as not mergeable for DIPO-73.
- [x] #6 A backlog PR the engine opened that is merged by hand is checked again right after the merge is seen; a failure is a notice, and `backlogCheckBlocked(office, key)` reports the affected stories until a new backlog PR fixes them, for `work.run` (DIPO-48) to skip them.
- [x] #7 Without a remote or without `gh` authenticated, no PR is opened and the engine reports the branch that is waiting.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S19b (DIPO-15). Before cutover: built by hand-run agents.

Implementation (DIPO-35):
- `platform/host.ts`: `GhHost`, the only code that runs `gh` (create, list, view, edit, close, squash-merge with `--match-head-commit`, `pr checks --required --json`). `MIN_GH_VERSION` is 2.50.0, the release that added `gh pr checks --json` (https://github.com/cli/cli/releases/tag/v2.50.0); older is refused with the version in the message, which the engine shows as a `backlog.pr.waiting` notice. Exported as `CodeHost` / `CodeHostError` because `HostError` is taken by the worker host.
- `backlog/pr/check.ts`: the pure structural check, rules `backlog-only`, `parses` (R02), `transition` (lane-b transitions of 0012 plus the To Do to Refined migration), `ready-decision`, `no-claim`. `diff.ts` gathers the diff by checking out `_backlog` at the merge base and at the head in turn inside one git queue item and viewing the changed tasks with the CLI (task files are never read directly), then restores the worktree.
- `backlog/pr/feature.ts`: `BacklogPrs.afterFlush` (lane hook) syncs open PRs, then opens or updates the one PR for the pushed branch and checks every new head; `sync` (after each story-index poll) re-checks a PR merged by hand; `recheck` for the merge slot (DIPO-73). `backlogPrMergeable` and `backlogCheckBlocked` are in `records.ts`.
- Migration 15 `backlog_prs` and `backlog_pr_blocks` (DIPO-39 took 14 on main before this branch was cut, so 15 is the next free number).

Scope additions:
- packages/engine/src/db/migrations/0015-backlog-prs.ts: new tables for the PR record, its check result and the stories a failed merged check blocks.
- packages/engine/src/db/schema.ts: registers migration 15.
- packages/engine/src/retention/policy.ts: retention tier for `backlog_prs` and `backlog_pr_blocks` (required for every office-scoped table).
- packages/engine/src/retention/run.ts: deletes closed PR rows and cleared blocks after stateDays.
- packages/engine/src/backlog/lane/lane.ts: `onFlushed` hook so the PR is opened or updated after each successful flush.
- packages/engine/src/backlog/lane/feature.ts: passes `onFlushed` through `BacklogLane`.
- packages/engine/src/stories/feature.ts: `onPolled` hook after each successful poll fetch, so a hand merge is seen within one poll interval.
- packages/engine/src/index.ts: exports the host and the backlog PR module.
- packages/daemon/src/foreground.ts: wires `BacklogPrs` with `GhHost` (the gh on the daemon PATH) into the lane and the story-index poll.
- packages/engine/test/platform/host.test.ts: unit tests of the host (version minimum, arguments, login failure).
- test/backlog-pr-title/backlog-pr-title.test.ts: root test that the engine's PR titles pass scripts/check-pr-title.ts (engine tests cannot import scripts/ because of the engine tsconfig rootDir).

Retention advisory (from DIPO-71): the check reads stored passing Ready decisions. Retention may delete a decision older than stateDays. The check runs when the PR opens or changes and right after a merge, normally well inside stateDays of the `ready` decision. If a backlog PR stays open longer than that, its check fails `ready-decision` with a notice saying to run `ready <ID>` again, which stores a fresh decision; the next update re-checks. No automatic re-evaluation was added.

Review round 1 (PR #77):
- Hand merge with a merge commit: `backlog_prs.checked_base` (migration 15, edited in place because it is not on main yet) stores the base each check diffed against. A merged head is checked against that base. For a head never checked, the fallback is the merge base with the merge commit's first parent, read through the host (`mergeCommit` in `gh pr view --json`). With neither, and the head already on the base, the check throws instead of passing an empty diff. Tests: merge commit in pr.test.ts; rebase merge and the fallback in pr.ci.test.ts; squash in the block-clearing CI test.
- A merged PR is recorded merged in the same transaction as its check result and blocks. A check that throws leaves it open, and the next sync retries it.
- A failed restore of `_backlog` after the diff reports both errors (`RestoreError`). The lane already checks out its branch (or the base) before every apply; a comment now says so, and a test checks that `_backlog` is back on the branch after a check.
- Decisions confirmed by the coordinator: retention is handled by the `ready-decision` notice telling the maintainer to run `ready <ID>` again (no automatic re-evaluation); blocks clear as described; a failure without a task blocks every touched story; every merged PR is re-checked until DIPO-73, which can skip the PRs it merged itself; the lane-b transitions match 0012 and 0010; `backlog.pr.*` stay engine.notice codes.
- No new files outside the scope additions already listed, apart from packages/engine/test/backlog/pr/diff.test.ts, which is inside the declared test scope.
<!-- SECTION:NOTES:END -->
