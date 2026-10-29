---
id: DIPO-318
title: Build the engine in one createEngine factory and shrink its public surface
status: In Progress
assignee: []
created_date: '2026-10-22 21:00'
updated_date: '2026-10-29 15:30'
labels:
  - 'tier:L'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-351
references:
  - packages/daemon/src/foreground.ts
  - packages/daemon/src/runs.ts
  - packages/daemon/src/server.ts
  - packages/engine/src/run/compose.ts
  - packages/engine/src/index.ts
  - packages/engine/src/
  - packages/engine/test/
  - packages/cli/src/index.ts
  - packages/daemon/test/
  - tools/lint/oxlint-plugin.js
  - .oxlintrc.json
  - test/lint-boundaries/
  - packages/contract/scripts/boundary.test.ts
type: chore
ordinal: 303000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the daemon gets a running engine from one `createEngine(deps)` call. That call owns the service wiring and the order of the load and recovery steps, and exposes `executeCommand`, `executeRead`, `subscribe`, `recover` and `drain`. The engine entry exports that surface, and short `dipo` commands no longer load the TUI and daemon code.

Context:
- `serve()` in `packages/daemon/src/foreground.ts` wires about 30 engine services through late-binding closures:
  - the command registry is used before it is defined;
  - the order of feature registration sets the load-step order;
  - the recovery-step order is fixed in the same function.
- `run/compose.ts` (DIPO-129) uses a mutable `late` object. StoryPrs and WorkRun are built in the daemon (`packages/daemon/src/runs.ts`); the merge slot and VerifyCommit leave with DIPO-350 and DIPO-346.
- The engine entry (`packages/engine/src/index.ts`) exports several hundred names, including the raw SQLite connection, and the daemon reaches `database.connection` directly.
- `packages/cli/src/index.ts` imports the tui and daemon packages statically, so every `dipo` call loads them.
- DIPO-127 caps function length at 100 lines.
- Folded in from DIPO-317 (2026-10-25): most engine sub-directories sit in one import cycle at directory level, and `import/no-cycle` catches only file-level cycles; the tui and client bans use `no-restricted-imports`, which ignores `import()` and `require`; contract purity is a regex test over top-level files only (`packages/contract/scripts/boundary.test.ts`); `ScriptedWorker` and other fakes sit in production source.
- The target is 0004 (the daemon imports only `createEngine`, the engine types and the platform entry) and 0005 section 12. Track 2 of the prune (0003): built by dipo after the cutover DIPO-351, when hooks, pricing and the srt sandbox are already gone.

```dipo
branch: "DIPO-318/create-engine-factory"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) createEngine starts with fakes, opens an office, runs a command and a read, and drains, without the daemon package"
    - kind: "automated"
      check: "(lint) each layer and package-ban fixture in test/lint-boundaries/ makes its rule fire"
    - kind: "automated"
      check: "(cli) dipo --version and dipo watch load neither the TUI nor the daemon package"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `createEngine(deps)` builds every engine service, StoryPrs and WorkRun included, with no late-binding closures. It registers the load and recovery steps in an order written in one list.
- [ ] #2 The daemon provides only the process concerns (lock, socket, signals, clock, logger, spawn, paths) and imports only `createEngine`, the engine types and the platform entry (0004). `serve()` is under 100 lines.
- [ ] #3 The engine entry exports the engine surface, the port types and what the daemon needs for its process concerns. The daemon no longer reaches the SQLite connection or `OfficeHandle` directly.
- [x] #4 An engine test starts `createEngine` with fakes, opens an office, runs a command and a read, and drains, without the daemon package.
- [ ] #5 The `dipo` CLI loads the TUI and daemon packages with a dynamic import, only in the subcommands that use them. A test shows that `dipo --version` and `dipo watch` load neither.
- [x] #6 A test records the order of the load and recovery steps and shows it is unchanged. Every existing test passes.
- [ ] #7 A `dipo/engine-layers` rule in `tools/lint/oxlint-plugin.js`, on in `.oxlintrc.json`, refuses a value import from a higher engine layer into a lower one. The layer of each sub-directory is listed in one place, a fixture in `test/lint-boundaries/` proves the rule fires, and no back-edge left after the prune needs an exception
- [ ] #8 Claude's tool names and model aliases appear only in `workers/claude-cli/`, and a lint rule or test shows it
- [ ] #9 The package bans for tui, client, engine and daemon also catch `import()` and `require`, and contract purity is checked over every contract source file, each proven by a fixture
- [ ] #10 `ScriptedWorker` and the other fakes move into testkit or test folders, the engine entry no longer exports them, and the binary build passes
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Part 1 in PR #435 (2026-10-29): createEngine builds every service in one written order (create/create-engine.ts, create/steps.ts); real cycles are closed in explicit connect steps through Partner, which throws before it is connected; lifecycle, recovery, drain and control moved into the engine; serve() is 50 lines. Criteria 1, 4 and 6 met. ADR 0005 'One factory' rewritten with the maintainer's approval: the daemon passes the shared clock, spawn and the start-time probe. Part 2: criterion 2's import restriction (the daemon still imports about 30 helpers from the engine entry), criterion 3 (shrink the engine entry), worker-host, restore, login and test-shell; deps fields for worker hosts, test-box forwarders and the model-proxy listener. Part 3: criteria 5 and 7 to 10.
<!-- SECTION:NOTES:END -->
