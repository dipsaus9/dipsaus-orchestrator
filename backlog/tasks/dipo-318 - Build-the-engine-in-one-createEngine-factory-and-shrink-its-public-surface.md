---
id: DIPO-318
title: Build the engine in one createEngine factory and shrink its public surface
status: Done
assignee: []
created_date: '2026-10-22 21:00'
updated_date: '2026-10-29 17:40'
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
- [x] #2 The daemon provides only the process concerns (lock, socket, signals, clock, logger, spawn, paths) and imports only `createEngine`, the engine types and the platform entry (0004). `serve()` is under 100 lines.
- [x] #3 The engine entry exports the engine surface, the port types and what the daemon needs for its process concerns. The daemon no longer reaches the SQLite connection or `OfficeHandle` directly.
- [x] #4 An engine test starts `createEngine` with fakes, opens an office, runs a command and a read, and drains, without the daemon package.
- [x] #5 The `dipo` CLI loads the TUI and daemon packages with a dynamic import, only in the subcommands that use them. A test shows that `dipo --version` and `dipo watch` load neither.
- [x] #6 A test records the order of the load and recovery steps and shows it is unchanged. Every existing test passes.
- [x] #7 A `dipo/engine-layers` rule in `tools/lint/oxlint-plugin.js`, on in `.oxlintrc.json`, refuses a value import from a higher engine layer into a lower one in coarse layers (base directories, one domain layer holding the measured cycle, then create/), listed in one place, with a fixture in `test/lint-boundaries/` that proves it fires; the fine layers and the moves that remove the back-edges are DIPO-381
- [x] #8 Claude's tool names and model aliases appear only in `workers/claude-cli/`, and a lint rule or test shows it
- [x] #9 The package bans for tui, client, engine and daemon also catch `import()` and `require`, and contract purity is checked over every contract source file, each proven by a fixture
- [x] #10 `ScriptedWorker` and the other fakes move into testkit or test folders, the engine entry no longer exports them, and the binary build passes
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Part 1 in PR #435 (2026-10-29): createEngine builds every service in one written order (create/create-engine.ts, create/steps.ts); real cycles are closed in explicit connect steps through Partner, which throws before it is connected; lifecycle, recovery, drain and control moved into the engine; serve() is 50 lines. Criteria 1, 4 and 6 met. ADR 0005 'One factory' rewritten with the maintainer's approval: the daemon passes the shared clock, spawn and the start-time probe. Part 2: criterion 2's import restriction (the daemon still imports about 30 helpers from the engine entry), criterion 3 (shrink the engine entry), worker-host, restore, login and test-shell; deps fields for worker hosts, test-box forwarders and the model-proxy listener. Part 3: criteria 5 and 7 to 10.

Part 2 in PR #436 (2026-10-29): the engine entry exports only createEngine, the surface and the port types (pinned by test/entries.test.ts); the daemon imports only that and @dipsaus-orchestrator/engine/platform, enforced by dipo/daemon-engine-imports (12 import forms, relative paths included); worker hosts, test-box forwarders and the model-proxy listener are deps; daemon socket tests run on a FakeSurface and the stored-state cases moved to engine tests on createEngine. Criteria 2 and 3 met. ADR 0004 and 0005 edits approved by the maintainer. Part 3: criteria 5 and 7 to 10; its deep-import rule must cover tools/recordings and test/office-rescan, which import engine modules by relative path.

Criterion 7 narrowed on 2026-10-29 to a coarse layer rule: the engine directories form one 20-directory import cycle with 31 back-edges, so the fine layer order is design work, split into spike DIPO-381.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The daemon gets a running engine from one createEngine(deps) call (#435): every service is built in one written order, real cycles are closed in explicit connect steps through Partner, and lifecycle, recovery and drain live in the engine; serve() is 50 lines. The engine entry exports only createEngine, the surface and the port types, and the daemon imports only that and the platform entry (#436). The CLI loads the TUI and daemon only in the subcommands that use them, and the fakes left production source (#437). One dipo/package-imports rule holds every package ban for every import form, the deep-import ban covers specifiers and relative paths, contract purity is checked over every source file, a coarse dipo/engine-layers rule (base, domain, composition) passes with no exception, and only the Claude adapter names Claude's tools and model aliases; WorkerSpec.tools became a developer-only web flag (#439). ADR 0004, 0005 and 0008 edits approved by the maintainer. The fine engine layers are spike DIPO-381.
<!-- SECTION:FINAL_SUMMARY:END -->
