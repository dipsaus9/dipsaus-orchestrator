---
id: DIPO-36
title: Initialise an office's Backlog.md settings and migrate To Do stories
status: In Progress
assignee:
  - '@claude'
created_date: '2026-10-11 18:48'
updated_date: '2026-10-13 15:41'
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
- [ ] #1 Step 1 rewrites only the `statuses:` line of `backlog/config.yml` to hold both the old statuses and `Refined`, `Ready`, `In Progress`, `In Review`, `Parked`, `Done`, and checks the result with `config get statuses`.
- [ ] #2 Step 2 sets `defaultStatus` to `Refined` through the CLI.
- [ ] #3 Step 3 moves every `To Do` task to `Refined` with `task edit -s Refined`; tasks `In Progress` on their own branches are left alone and listed.
- [ ] #4 `check_active_branches: true`, `remote_operations: true` and `auto_commit: false` are set when they differ.
- [ ] #5 `.dipo/.gitignore` with the single line `office.local.yaml` is added only if absent.
- [ ] #6 Previous values are stored in `backlog_config_previous`.
- [ ] #7 All steps are lane-b operations on one engine branch and one backlog PR, which the engine opens and auto-merges after the structural check (DIPO-35, DIPO-73); running init twice adds no commits.
- [ ] #8 A later init run, once no task uses `To Do`, sets the 0012 status list alone.
- [ ] #9 The contract command `office.init { office }` (DIPO-19), registered through the DIPO-22 registry, runs init and replies with `changed` and the PR or waiting branch; `dipo office init` sends it and prints that reply.
- [ ] #10 While `In Review` or `Parked` is missing from the base's statuses, office load raises a notice and `officeStatusesReady(office)` returns a refusal message naming `dipo office init`, for `work.run` (DIPO-48) to refuse runs.
- [ ] #11 Init never writes `.dipo/office.yaml`; without the file the built-in defaults apply.
- [ ] #12 The contract definition of `office.init` (DIPO-19, provisional) gets its final result shape and `since` in place of `provisional: true`, set to the next unreleased contract minor (`CONTRACT_VERSION.minor` is bumped only when no unreleased bump exists yet), the schema files are regenerated with `bun run contract:schema`, and `commands.describe` lists it.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S20 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
