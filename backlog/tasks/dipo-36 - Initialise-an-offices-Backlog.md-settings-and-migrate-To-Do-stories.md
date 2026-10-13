---
id: DIPO-36
title: Initialise an office's Backlog.md settings and migrate To Do stories
status: Done
assignee:
  - '@claude'
created_date: '2026-10-11 18:48'
updated_date: '2026-10-13 21:21'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-27
  - DIPO-73
references:
  - packages/engine/src/office/init/
  - packages/engine/src/db/migrations/
  - packages/cli/src/
  - packages/engine/test/office/
  - packages/engine/src/features.ts
  - packages/contract/
  - packages/daemon/src/foreground.ts
  - packages/engine/src/backlog/lane/
  - packages/engine/src/backlog/pr/
  - packages/engine/test/backlog/pr/
  - packages/engine/src/db/schema.ts
  - packages/engine/src/index.ts
  - packages/engine/src/retention/policy.ts
  - packages/engine/src/merge-slot/slot.ts
  - packages/engine/test/merge-slot/
documentation:
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0007-state-database.md
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0010-backlog-and-git-integration.md
  - docs/decisions/0012-story-standard.md
priority: high
type: feature
ordinal: 36000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo office init` prepares an office's backlog for the 0012 lifecycle through one backlog-lane PR (statuses, default status, `To Do` migration, office checks, `.dipo/.gitignore`) that the engine opens and auto-merges after its structural check, records previous values, and office load refuses runs until the statuses are present on the base.

Context: this is the one-time migration of this repository at cutover (0012 consequences). Init does not write `.dipo/office.yaml`; the built-in 0008 defaults apply until a story adds the file (M0 breakdown decision D9, DIPO-15). The PR is opened and checked through DIPO-35 and merged through DIPO-73 (M0 breakdown decision D4, DIPO-15). `office.init` is a contract command (0005 amendment of 2026-10-12). The run refusal is a predicate that DIPO-48 uses, because `work.run` does not exist yet (M0 review, DIPO-15). `office uninstall` is deferred. References: 0010 section 2 (lane b PR), section 6 (init and migration steps, office checks), section 11 (additive and removable); 0007 section 2 (`.dipo/.gitignore` added only if absent), section 4 (`backlog_config_previous`); 0012 section 2 (status list, `default_status`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-36/initialise-office-s-backlog-md-settings"
unknowns:
  - q: "Who opens and merges the backlog PR in M0?"
    status: "resolved"
    answer: "maintainer decision D4 of the M0 breakdown (2026-10-11, recorded in DIPO-15): the engine opens it and auto-merges it after its structural check, through DIPO-35."
  - q: "Does init write `.dipo/office.yaml`?"
    status: "resolved"
    answer: "maintainer decision D9 of the M0 breakdown (2026-10-11, recorded in DIPO-15): no; the built-in 0008 defaults apply; init still writes `.dipo/.gitignore`."
test_plan:
  entries:
    - kind: "automated"
      check: "(integration) init on a copy of the Backlog fixture with `To Do` tasks produces the commits of steps 1 to 5 on one branch; a second run adds none; no `.dipo/office.yaml` is written."
    - kind: "automated"
      check: "(engine) with a fake host, `office.init` opens one backlog PR that passes the structural check and is merged; `officeStatusesReady` refuses before the merge and passes after."
    - kind: "manual"
      check: "`dipo office init` in a scratch GitHub clone of this repository"
      expect: "a `chore(backlog): ...` PR opens whose diff touches only `backlog/config.yml`, `To Do` task files and `.dipo/.gitignore`, and the engine merges it once `ci-ok` and `pr-title` are green."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Step 1 rewrites only the `statuses:` line of `backlog/config.yml` to hold both the old statuses and `Refined`, `Ready`, `In Progress`, `In Review`, `Parked`, `Done`, and checks the result with `config get statuses`.
- [x] #2 Step 2 sets `defaultStatus` to `Refined` through the CLI.
- [x] #3 Step 3 moves every `To Do` task to `Refined` with `task edit -s Refined`; tasks `In Progress` on their own branches are left alone and listed.
- [x] #4 `check_active_branches: true`, `remote_operations: true` and `auto_commit: false` are set when they differ.
- [x] #5 `.dipo/.gitignore` with the single line `office.local.yaml` is added only if absent.
- [x] #6 Previous values are stored in `backlog_config_previous`.
- [x] #7 All steps are lane-b operations on one engine branch and one backlog PR, which the engine opens and auto-merges after the structural check (DIPO-35, DIPO-73); running init twice adds no commits.
- [x] #8 A later init run, once no task uses `To Do`, sets the 0012 status list alone.
- [x] #9 The contract command `office.init { office }` (DIPO-19), registered through the DIPO-22 registry, runs init and replies with `changed` and the PR or waiting branch; `dipo office init` sends it and prints that reply.
- [x] #10 While `In Review` or `Parked` is missing from the base's statuses, office load raises a notice and `officeStatusesReady(office)` returns a refusal message naming `dipo office init`, for `work.run` (DIPO-48) to refuse runs.
- [x] #11 Init never writes `.dipo/office.yaml`; without the file the built-in defaults apply.
- [x] #12 The contract definition of `office.init` (DIPO-19, provisional) gets its final result shape and `since` in place of `provisional: true`, set to the next unreleased contract minor (`CONTRACT_VERSION.minor` is bumped only when no unreleased bump exists yet), the schema files are regenerated with `bun run contract:schema`, and `commands.describe` lists it.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built in packages/engine/src/office/init/ (OfficeInit, the lane kind `init`, backlog_config_previous in migration 17, officeStatusesReady), wired in the daemon, `dipo office init` in the CLI, `office.init` shipped in contract minor 1 (unreleased, no bump).

Decisions taken while building:
- Step order on the branch: statuses, defaultStatus, settings (checkActiveBranches, remoteOperations, autoCommit), To Do migration, .dipo/.gitignore. The settings step runs before the migration so a CLI with autoCommit on cannot commit the migration's edits itself.
- A To Do task counts as in progress on its own branch when a local or remote branch named `<ID>/...` exists (the F15 frozen branch shape); such tasks are left alone, listed in the reply (`leftAlone`) and in an engine.notice.
- Step 4 (0012 list alone) is planned when no task on the base uses To Do; statuses outside 0012 that tasks still use are kept.
- Only steps that differ on the base are journaled, and a step already open in the journal with the same target is not journaled again, so a second run adds no commit.
- The structural check (DIPO-35) now allows a PR to add `.dipo/.gitignore` (never change or remove it): 0010's amendment puts that file in the office-init backlog PR.
- officeStatusesReady reads backlog/config.yml on <remote>/<base> (local <base> without a remote) with git cat-file; the load step office.statuses raises office.statusesMissing.
- The merge happens through the merge slot's poll while the daemon runs; after a daemon restart the poll resumes when the office loads again (first office command), since loading offices at daemon start is DIPO-56.

Review round 1: scope additions recorded as References (daemon wiring, backlog lane atBase, backlog PR check exception for adding .dipo/.gitignore, migration registration, engine re-export, retention row). leftAlone notice and CLI line now say a <ID>/... branch exists and how to unblock a leftover one.

Live test fix: the merge slot's poll ended at its first timer because it called the office manager's config() detached from the manager (TypeError on this.#instances), so a backlog PR whose checks were pending at the kick never merged. The poll now calls it on the directory, re-arms even when a poll throws, and logs each tick's outcome at debug level. Scope additions: packages/engine/src/merge-slot/slot.ts, packages/engine/test/merge-slot/.

Live test 2026-10-13 on dipsaus9/dipo-scratch-backlog (build 7fda247): after a daemon restart the merge slot merged init PR #4; the next init opened PR #5 (chore(backlog): init statuses, removes To Do only); a further init reported the open PR and changed nothing. The live test also found the merge-slot poll bug from DIPO-73 (detached OfficeManager.config call), fixed on this branch.
<!-- SECTION:NOTES:END -->
