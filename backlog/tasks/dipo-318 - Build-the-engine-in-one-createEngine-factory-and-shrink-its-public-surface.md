---
id: DIPO-318
title: Build the engine in one createEngine factory and shrink its public surface
status: Refined
assignee: []
created_date: '2026-10-22 21:00'
updated_date: '2026-10-22 21:00'
labels:
  - 'tier:L'
milestone: m-2
dependencies:
  - DIPO-317
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
- `run/compose.ts` (DIPO-129) uses a mutable `late` object. VerifyCommit, StoryPrs, MergeSlot and WorkRun are built in the daemon (`packages/daemon/src/runs.ts`).
- The engine entry (`packages/engine/src/index.ts`) exports several hundred names, including the raw SQLite connection, and the daemon reaches `database.connection` directly.
- `packages/cli/src/index.ts` imports the tui and daemon packages statically, so every `dipo` call loads them.
- DIPO-127 caps function length at 100 lines.

```dipo
branch: "DIPO-318/create-engine-factory"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `createEngine(deps)` builds every engine service, VerifyCommit, StoryPrs, MergeSlot and WorkRun included, with no late-binding closures. It registers the load and recovery steps in an order written in one list.
- [ ] #2 The daemon provides only the process concerns (lock, socket, signals, clock, logger, spawn, paths) and calls `createEngine`. `serve()` is under 100 lines.
- [ ] #3 The engine entry exports the engine surface, the port types and what the daemon needs for its process concerns. The daemon no longer reaches the SQLite connection or `OfficeHandle` directly.
- [ ] #4 An engine test starts `createEngine` with fakes, opens an office, runs a command and a read, and drains, without the daemon package.
- [ ] #5 The `dipo` CLI loads the TUI and daemon packages with a dynamic import, only in the subcommands that use them. A test shows that `dipo --version` and `dipo watch` load neither.
- [ ] #6 A test records the order of the load and recovery steps and shows it is unchanged. Every existing test passes.
<!-- AC:END -->
