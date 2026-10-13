---
id: DIPO-48
title: Pick and claim one Ready story with work.run
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-13 06:31'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-32
  - DIPO-36
  - DIPO-38
  - DIPO-43
  - DIPO-47
  - DIPO-71
  - DIPO-72
references:
  - packages/engine/src/run/
  - packages/engine/src/db/migrations/
  - packages/cli/src/
  - packages/engine/test/run/
  - packages/engine/src/features.ts
  - packages/engine/src/office/
  - packages/contract/
  - packages/engine/src/commands/
  - packages/engine/test/commands/
  - packages/engine/src/git/
  - packages/engine/test/git/
  - packages/engine/test/office/
documentation:
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0007-state-database.md
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0010-backlog-and-git-integration.md
  - docs/decisions/0012-story-standard.md
  - docs/decisions/0013-repo-scan-and-script-standard.md
  - docs/decisions/0014-worker-prompt-assembly.md
priority: high
type: feature
ordinal: 48000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `work.run` (and `dipo run [ID]`) picks one Ready story from `origin/<base>` or the named one, refuses or skips it with a stated reason when any office or story check says no, runs the pickup re-check and the claim, records the run, and emits `work.assigned` and `work.phase setup`.

Context: M0 runs one story at a time; `maxAgents` above 1 is refused until M2. Starting the worker after the claim (setup, launch checks, prompt, host, ingestion, `work.phase build`) was split into DIPO-74 in the M0 review (DIPO-15). Earlier stories expose their run decisions as predicates that this story consumes (M0 review, DIPO-15): `configBlocksRuns` and the active-work check of `office.forget` (DIPO-27), `pendingLaneOp` (DIPO-34), `backlogCheckBlocked` (DIPO-35), `officeStatusesReady` (DIPO-36), `adapterHeld` (DIPO-43), `assembleContract` (DIPO-47), `verifyResolved` (DIPO-72), and the daemon's scheduling predicate (DIPO-68). The pickup decision is stored through DIPO-71. The `runs` table already holds the second run kind, `session`, with no story key, worktree or branch, used later for the M1 scan fallback, M3 interviews and M5 conversation; M0 starts only `story` runs (maintainer decision D12, DIPO-15; 0007 and 0008 amendments of 2026-10-12). `work.run` is added through the registration seam of DIPO-22. References: 0005 section 4 (`work.run` args, result, skips, failed re-check emits `story.state` to Refined), section 5 (`work.assigned`, `work.phase`); 0012 section 2 (Ready to In Progress, eligibility: Ready plus dependencies Done), section 3 (pickup mode); 0010 section 2 (Ready on `origin/<base>`, pending lane-b skip), section 7 (claim); 0013 section 2 (refuse when verify unresolved); 0014 section 4 (contract backstop handled like a failed re-check); 0008 section 9 (tier to caps); 0007 section 4 (`runs`, `run_steps`, `config_snapshots`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-48/start-run-one-ready-story"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a Ready fixture story goes to In Progress with one claim commit, a stored pickup decision and events `work.assigned` and `work.phase setup`."
    - kind: "automated"
      check: "(engine) a story with an open unknown edited in by hand fails the re-check and returns to Refined with the R15 message; a story over `prompt.contractMax` returns to Refined with the assembly error."
    - kind: "automated"
      check: "(engine) a dependency not Done gives `dependency`; a pending lane-b operation and a failed backlog PR check each give `notRunnable`."
    - kind: "automated"
      check: "(engine) each refusal (unresolved verify, missing statuses, invalid configuration, adapter hold, `safe` state) refuses with its message; `office.forget` with an active run fails `office.busy`."
    - kind: "automated"
      check: "(unit) a `session` run row with no key, worktree or branch passes the schema test."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Migrations add `runs` (with `kind` `story` or `session` and a nullable `key`), `run_steps` and `config_snapshots`; a `session` run has no key, worktree or branch, and its usage is recorded under the office.
- [ ] #2 Without `stories`, the engine indexes stories (DIPO-32), then picks the first Ready story on `origin/<base>` by priority and ordinal whose dependencies are all Done; with `stories`, only those; `maxAgents` above 1 fails with `args.invalid`.
- [ ] #3 Each story not started is a skip with a `SkipReason`: `notReady`, `dependency`, `notRunnable` (including `pendingLaneOp` and `backlogCheckBlocked`), `collision`, `capacity` or `pickupCheckFailed`.
- [ ] #4 The run is refused with the predicate's message when `verifyResolved`, `officeStatusesReady`, `configBlocksRuns` or `adapterHeld` refuses, and with the retryable `scheduling.off` in `safe`.
- [ ] #5 A failed pickup re-check, stored through DIPO-71, moves the story to Refined through the backlog lane and emits `story.state` with the gate messages in `detail`.
- [ ] #6 Before the claim, `assembleContract` (DIPO-47) runs; `prompt.contractTooLarge` moves the story to Refined like a failed pickup re-check, with the assembly error in `detail`.
- [ ] #7 The engine registers its active-run check, so `office.forget` (DIPO-27) fails with `office.busy` while a run is active.
- [ ] #8 A claimed run records kind `story`, tier, role `developer`, model, start SHA, branch, worktree, budget unit and limit, loop cap, `config_hash` and run profile id.
- [ ] #9 The engine emits `work.assigned` and `work.phase setup`, and keeps one active run per office.
- [ ] #10 `dipo run [ID]` prints started and skipped stories with reasons.
- [ ] #11 `work.run` resolved from the current directory carries the CLI's main worktree as an optional `from` argument (an additive minor contract change, `CONTRACT_VERSION.minor` bumped only when no unreleased bump exists yet), and the daemon refuses with `office.unknown` when it differs from the office's registered path, as DIPO-27 does for `office.forget` and `office.reloadConfig`; the check moves into shared office resolution in `commands/execute.ts` so every later cwd-resolved command gets it. A test covers an unopened copy.
- [ ] #12 `office.reloadConfig` passes the new git settings to `OfficeGit.configure()` (DIPO-31 reads them only at office load); a test changes `base` and the worktree root through a reload.
- [ ] #13 `git.fetchFailed` (DIPO-31) is added to the contract's `RETRYABLE_ERROR_CODES` (0005 amendment of 2026-10-13; additive minor, `CONTRACT_VERSION.minor` bumped only when no unreleased bump exists yet), `work.run` fails with it as a retryable command error, and the contract test listing the retryable codes is updated.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S32 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
