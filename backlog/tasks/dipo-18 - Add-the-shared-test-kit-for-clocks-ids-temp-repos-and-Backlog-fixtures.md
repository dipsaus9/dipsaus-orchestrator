---
id: DIPO-18
title: 'Add the shared test kit for clocks, ids, temp repos and Backlog fixtures'
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 11:38'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-16
references:
  - packages/testkit/
  - packages/engine/src/platform/clock.ts
  - packages/engine/src/platform/ids.ts
  - packages/engine/test/fixtures/backlog/
  - package.json
  - bun.lock
  - .oxlintrc.json
  - tsconfig.json
  - test/lint-boundaries/
  - packages/contract/
  - packages/engine/src/index.ts
  - tools/lint/
  - packages/engine/package.json
  - packages/engine/tsconfig.json
  - packages/engine/src/platform/
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

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

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
- [x] #1 `packages/contract/src/runtime.ts` exports the `Clock` interface (`now()`, `setTimeout`, `clearTimeout`), the `IdSource` interface, and the `Spawn` and `ChildProcess` types used to inject process creation, as types only, with no I/O, and `contract` re-exports them from its entry.
- [x] #2 `packages/engine/src/platform/clock.ts` exports the system `Clock` and `ids.ts` exports the system `IdSource` with ULID ids for the 0005 prefixes, both typed against the `contract` interfaces; the ULID generator is implemented locally with no added dependency.
- [x] #3 `packages/testkit` exports `ManualClock` (advance fires due timers in order) and `SequentialIds` (`run-0001` style) implementing the `contract` interfaces, plus `withTempRepo(fn)`, `withBareRemote(fn)` and `withTempDir(fn)`; testkit is a devDependency only and imports neither `engine` nor `daemon`.
- [x] #4 `withTempRepo` creates the directory as `dipo-XXXX` under `$DIPO_TMP` when set (the sandboxed verify temp root of DIPO-37), else under `/tmp`, runs `git init -b main`, applies a fixture tree, and removes it in `finally` unless `DIPO_TEST_KEEP=1`.
- [x] #5 Every git call made through testkit runs with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `HOME` set to the temp directory, fixed author and committer identity and dates, and no signing.
- [x] #6 `backlog.md` 1.53.0 is a pinned root devDependency, and a fixture project generated by that CLI lives under `packages/engine/test/fixtures/backlog/` with a draft, a task with a test-plan field block, a task with `not_applicable`, and a task on hold.
- [x] #7 A helper runs tests with `ANTHROPIC_*`, `CLAUDE_*` and `GH_*` variables removed from the environment.
- [x] #8 Lint fails on `Date.now`, `new Date()` without arguments and global timers outside `packages/engine/src/platform/` and `packages/testkit/`, and on `spawnSync` or `execSync` anywhere in `packages/engine/src/` and `packages/daemon/src/`; a test proves each violation is reported.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S03 (DIPO-15). Before cutover: built by hand-run agents.

Implemented (DIPO-18):
- contract/src/runtime.ts: Clock (now, setTimeout, clearTimeout with an opaque TimerHandle), IdSource (next(prefix) for the 0005 prefixes off, sto, run, agt, gat, qst, tst), Signal, SpawnOptions, ChildStdin, ChildExit, ChildProcess and Spawn. Types only; a test asserts the module has no runtime exports.
- engine/src/platform: systemClock; createUlid (monotonic ULID, local, no dependency; same-ms ids increment the random part, a clock step back stays on the last time), createSystemIds(clock) and systemIds giving <prefix>_<ulid>. Exported from the engine entry. No system Spawn yet: DIPO-42/44 own it.
- testkit: ManualClock (advance/advanceTo fire due timers in due order, ties by set order, never early), SequentialIds (run-0001, per prefix), cleanEnv/withCleanEnv (drop ANTHROPIC_*, CLAUDE_*, GH_*), withTempDir, withTempRepo, withBareRemote, isolatedEnv, git, runCommand. Layout: $DIPO_TMP or /tmp / dipo-XXXXXX / {repo, home, origin.git}; HOME is the home dir inside it. Git env drops inherited GIT_* and sets GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1, fixed identity and 2026-01-01T00:00:00Z dates, and commit/tag signing off through GIT_CONFIG_COUNT so it also reaches git run by the backlog CLI. testkit depends only on contract; engine has it as devDependency.
- backlog.md 1.53.0 pinned as root devDependency. Fixture at packages/engine/test/fixtures/backlog/backlog, generated with that CLI: backlog init dipo-fixture --defaults --integration-mode none --check-branches false --include-remote false --auto-open-browser false; statuses line set to the 0012 list by hand (config set statuses is refused, 0010 fact 6); config set defaultStatus Refined; draft create DRAFT-1; task create TASK-1 (Ready, automated and manual test plan), TASK-2 (Refined, test_plan not_applicable), TASK-3 (Parked, park reason on-hold). Regenerate the same way when the pin changes.
- Lint: no-restricted-globals (timers) and no-restricted-properties (Date.now, globalThis timers) everywhere except packages/engine/src/platform/ and packages/testkit/. oxlint has no no-restricted-syntax, so new Date() without arguments is a local JS plugin rule dipo/no-argless-date in tools/lint/oxlint-plugin.js (oxlint jsPlugins). spawnSync, execSync and execFileSync are banned in packages/engine/src (platform too) and packages/daemon/src as properties on any object (Bun.spawnSync, cp.spawnSync) and as named imports from node:child_process, child_process and bun. testkit may not import engine or daemon. test/lint-boundaries/lint-time-and-spawn.test.ts proves each ban and the allowed places; the shared runner moved to lint-tree.ts.
- Deviation from declared scope: tools/lint/oxlint-plugin.js is new (needed for the new Date() rule).

Scope widened at review (orchestrator): tools/lint/ holds a local oxlint jsPlugin for the `new Date()` ban, because oxlint 1.87 has no no-restricted-syntax; an AST rule was preferred over the grep test 0017 section 4 allows, since it lets `new Date(value)` through. packages/engine/package.json and tsconfig.json take testkit as a devDependency and project reference (AC #3). packages/engine/src/platform/ covers the colocated clock and ids tests the test plan requires. The empty directories in the Backlog fixture are not committed; `backlog task list` works without them.
<!-- SECTION:NOTES:END -->
