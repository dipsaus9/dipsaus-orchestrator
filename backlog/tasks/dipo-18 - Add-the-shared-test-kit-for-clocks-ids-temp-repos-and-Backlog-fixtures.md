---
id: DIPO-18
title: 'Add the shared test kit for clocks, ids, temp repos and Backlog fixtures'
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 09:25'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-16
references:
  - packages/contract/src/runtime.ts
  - packages/testkit/
  - packages/engine/src/platform/clock.ts
  - packages/engine/src/platform/ids.ts
  - packages/engine/test/fixtures/backlog/
  - package.json
  - bun.lock
  - .oxlintrc.json
  - tsconfig.json
  - test/lint-boundaries/
documentation:
  - docs/decisions/0001-foundational-decisions.md
  - docs/decisions/0004-language-and-runtime.md
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0007-state-database.md
  - docs/decisions/0017-testing-strategy-and-configuration.md
priority: high
type: task
ordinal: 18000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: tests in every package can use a manual clock, sequential ids, isolated temporary git repositories with a bare remote, and a pinned Backlog.md fixture project, and engine code is barred from reading wall-clock time directly.

Context: 0017 needs these helpers in engine, daemon and client tests. A private `packages/testkit` workspace package holds them so no client test imports `engine` (see M0 breakdown decision D5, DIPO-15). The `Clock` and `IdSource` interfaces live in `packages/contract` as types only, so `testkit` implements them without importing `engine`; the engine platform module holds the system implementations. `Spawn` and `ChildProcess` join them so the worker host and the fake process (DIPO-42, DIPO-44) inject process creation through one type (M0 review, DIPO-15). `spawnSync` is banned in the daemon because it blocks every office on the one JS thread (0007 section 1). References: 0017 section 3 (`withTempRepo`, isolated git, bare remote, Backlog fixture, cleaned environment), section 4 (Clock, IdSource, lint ban, temp dirs and sockets); 0004 "Repo layout".

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

```dipo
branch: "DIPO-18/add-shared-test-kit-clocks-ids-temp"
unknowns:
  - q: "Shared test helpers in a new private package `packages/testkit` not named in 0004?"
    status: "resolved"
    answer: "maintainer decision D5 of the M0 breakdown (2026-10-11, recorded in DIPO-15): a private `packages/testkit`, devDependency only; recorded as an amendment in 0004."
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) `ManualClock` fires timers in due order and never early; `SequentialIds` is deterministic."
    - kind: "automated"
      check: "(integration) `withTempRepo` with `withBareRemote` supports commit, push and fetch, and leaves no directory behind."
    - kind: "automated"
      check: "(integration) `backlog task list --plain` runs in a copy of the fixture project with the pinned CLI."
    - kind: "automated"
      check: "(unit) the lint ban reports `Date.now()` in an engine fixture file and `spawnSync` in a daemon fixture file."
    - kind: "automated"
      check: "(unit) the system `IdSource` gives 26-character Crockford ULIDs that sort by creation time within one millisecond."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `packages/contract/src/runtime.ts` exports the `Clock` interface (`now()`, `setTimeout`, `clearTimeout`), the `IdSource` interface, and the `Spawn` and `ChildProcess` types used to inject process creation, as types only, with no I/O, and `contract` re-exports them from its entry.
- [ ] #2 `packages/engine/src/platform/clock.ts` exports the system `Clock` and `ids.ts` exports the system `IdSource` with ULID ids for the 0005 prefixes, both typed against the `contract` interfaces; the ULID generator is implemented locally with no added dependency.
- [ ] #3 `packages/testkit` exports `ManualClock` (advance fires due timers in order) and `SequentialIds` (`run-0001` style) implementing the `contract` interfaces, plus `withTempRepo(fn)`, `withBareRemote(fn)` and `withTempDir(fn)`; testkit is a devDependency only and imports neither `engine` nor `daemon`.
- [ ] #4 `withTempRepo` creates the directory as `dipo-XXXX` under `$DIPO_TMP` when set (the sandboxed verify temp root of DIPO-37), else under `/tmp`, runs `git init -b main`, applies a fixture tree, and removes it in `finally` unless `DIPO_TEST_KEEP=1`.
- [ ] #5 Every git call made through testkit runs with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `HOME` set to the temp directory, fixed author and committer identity and dates, and no signing.
- [ ] #6 `backlog.md` 1.53.0 is a pinned root devDependency, and a fixture project generated by that CLI lives under `packages/engine/test/fixtures/backlog/` with a draft, a task with a test-plan field block, a task with `not_applicable`, and a task on hold.
- [ ] #7 A helper runs tests with `ANTHROPIC_*`, `CLAUDE_*` and `GH_*` variables removed from the environment.
- [ ] #8 Lint fails on `Date.now`, `new Date()` without arguments and global timers outside `packages/engine/src/platform/` and `packages/testkit/`, and on `spawnSync` or `execSync` anywhere in `packages/engine/src/` and `packages/daemon/src/`; a test proves each violation is reported.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S03 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
