---
id: DIPO-27
title: Open and forget offices
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 11:37'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-26
  - DIPO-70
references:
  - packages/engine/src/office/
  - packages/engine/src/db/migrations/
  - packages/cli/src/
  - packages/engine/test/office/
  - packages/engine/src/features.ts
documentation:
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0006-daemon-and-ipc.md
  - docs/decisions/0007-state-database.md
  - docs/decisions/0017-testing-strategy-and-configuration.md
priority: high
type: feature
ordinal: 27000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo office open [path]` registers a git repository with Backlog.md as an office with an `off_<ulid>` id and a marker in `.git/dipo/office.json`, the daemon loads an office's engine instance on first use, and `dipo office forget` removes it from the list without touching the repository.

Context: changing the office's Backlog.md settings is DIPO-36. This story adds the office load-step seam next to DIPO-22's command and read registry (M0 review, DIPO-15): the Backlog CLI version check (DIPO-28), the story index (DIPO-32), the scan (DIPO-72) and journal replay (DIPO-34) register as load steps. `office.reloadConfig` moved here from DIPO-26 in the M0 review; whether a run may start is decided in DIPO-48 from the predicates this story and others expose. References: 0017 section 5 (invalid configuration blocks new runs, running workers keep theirs, reload command); 0006 decision 4 (explicit registration, switching is client state, lazy loading), open question 2 (interactive prompt in an unregistered project); 0007 sections 2 (main worktree as office path, `<git-common-dir>/dipo/`, copy detection, network filesystem warning), 3 (`offices` table, `forgotten_at`, missing path notice); 0005 section 4 (`office.open`, `office.forget`, errors).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-27/open-forget-offices"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(integration) open a temp repo with the Backlog fixture; marker, row and event present; reopen is idempotent; linked worktree opens the same office."
    - kind: "automated"
      check: "(integration) copied repository gets a new id; moved repository keeps it."
    - kind: "automated"
      check: "(engine) forget then reopen restores rows; forget while a stub active-work check reports work fails `office.busy`."
    - kind: "automated"
      check: "(engine) `office.reloadConfig` with an invalid file keeps the previous configuration and `configBlocksRuns` returns the errors; a valid reload clears them."
    - kind: "automated"
      check: "(unit) registered load steps run in registration order; a failing step refuses the office with a notice naming it."
    - kind: "manual"
      check: "run `dipo office open` in this repository"
      expect: "prints the office id; `ls .git/dipo` shows `office.json`; `git status` shows no change."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `office.open { path }` resolves the main worktree with `git worktree list --porcelain` and the common directory with `git rev-parse --path-format=absolute --git-common-dir`; a linked worktree opens the same office.
- [ ] #2 A path that is not a git repository with a `backlog/config.yml` fails with `office.notProject`; a missing path fails with `office.pathMissing`.
- [ ] #3 A new office gets `off_<ulid>`, a `0700` `<git-common-dir>/dipo/` directory with `office.json { officeId, createdAt }`, an `offices` row with a random epoch, and an `office.registered` event; the reply has `registered: true`.
- [ ] #4 Opening a registered path again replies `registered: false` and `changed: false`; a forgotten office is restored with its rows.
- [ ] #5 A marker whose id is registered at another existing path gets a new id and marker with an `engine.notice`; when the other path is gone it is treated as a move and the row's path is updated.
- [ ] #6 `office.forget` sets `forgotten_at`, emits `office.forgotten`, keeps every row, and fails with `office.busy` when a registered active-work check reports work for the office; DIPO-48 registers the run check, and this story tests with a stub check.
- [ ] #7 Office-level commands load the office's engine instance lazily and refuse an office whose `office.json` id differs from its row.
- [ ] #8 Office load runs the load steps that feature modules add with `registerLoadStep(name, fn)` from their `register(registry)`, in registration order, so later stories add load steps without editing `office/`; a failing step refuses the office with a notice naming the step.
- [ ] #9 At load and on `office.reloadConfig { office }` the office reads its configuration (DIPO-26); an invalid result keeps the previous configuration for running work, emits an `engine.notice` with the errors, and `configBlocksRuns(office)` returns them until a valid reload, for `work.run` (DIPO-48) to refuse new runs.
- [ ] #10 The CLI resolves the office from `--office`, else from the current directory; an unregistered Backlog.md project prints "not an office, run `dipo office open`", and an interactive terminal is asked once to open it.
- [ ] #11 A repository on a network filesystem gets a warning at open.
- [ ] #12 The contract definition of `office.reloadConfig` (DIPO-19, provisional) gets its final result shape and `since: <minor>` in place of `provisional: true`, `CONTRACT_VERSION.minor` is bumped, the schema files are regenerated, and `commands.describe` lists it.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S12 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
