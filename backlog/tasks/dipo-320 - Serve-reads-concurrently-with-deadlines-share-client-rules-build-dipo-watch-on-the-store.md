---
id: DIPO-320
title: >-
  Serve reads concurrently with deadlines, share client rules, build dipo watch
  on the store
status: Refined
assignee: []
created_date: '2026-10-22 21:00'
updated_date: '2026-10-22 21:00'
labels:
  - 'tier:L'
milestone: m-2
dependencies:
  - DIPO-313
references:
  - packages/daemon/src/server.ts
  - packages/engine/src/commands/execute.ts
  - packages/engine/src/reads/execute.ts
  - packages/engine/src/reads/hello.ts
  - packages/contract/src/version.ts
  - packages/engine/src/platform/
  - packages/client/src/node/lifecycle/
  - packages/client/src/node/logs/reader.ts
  - packages/client/src/store/office-store.ts
  - packages/client/src/
  - test/lifecycle-parity/
  - packages/cli/src/watch-command.ts
  - packages/cli/src/
  - packages/tui/src/app.tsx
  - packages/tui/src/views.tsx
  - packages/tui/src/
  - packages/daemon/test/
  - packages/client/test/
type: enhancement
ordinal: 305000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: one slow read no longer freezes a client connection, and every command and read writes one log line with its outcome and duration. The runtime layout rules exist once, for both the engine and the client. `dipo watch` builds on the client store and uses the same formatters as the TUI. The TUI honours NO_COLOR everywhere and reads from the contract which commands need confirmation. From v0.1.0, a client refuses a daemon whose contract minor version is too old for it.

Context:
- **Reads.** `packages/daemon/src/server.ts` awaits reads and subscribes in order on each connection, and no request has a server-side deadline. The command and read executors (`commands/execute.ts`, `reads/execute.ts`) log nothing.
- **Duplicated runtime rules.** Process identity, lock and runtime-record parsing, the state-folder rule and the log-rotation names exist in `engine/src/platform/` and again in `client/src/node/lifecycle/`. A parity test (`test/lifecycle-parity/`) keeps the two in line.
- **`dipo watch`.** `packages/cli/src/watch-command.ts` folds events itself. The CLI and TUI each have their own percent formatting, health labels and output-range codec, and `storyRef` is copied four times. The TUI hard-codes which actions confirm, while the CLI reads `definition.confirm`.
- **TUI.** Direct colour sites in the TUI bypass the NO_COLOR handling of `Colored`, and `App` (`tui/src/app.tsx`) holds the key handling of every mode.
- **Version check.** `reads/hello.ts` compares only the contract major (`contract/src/version.ts`).

```dipo
branch: "DIPO-320/concurrent-reads-shared-client-rules"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Reads are dispatched concurrently on each connection, keyed by request id. Only subscribes to the same stream stay in order. Each read has a deadline, after which it answers a coded `timedOut`.
- [ ] #2 The command and read executors write one structured log line per request: name, request id, office, outcome code and milliseconds.
- [ ] #3 The runtime layout rules live in one runtime-free module that both engine and client import, and the parity test is removed.
- [ ] #4 `dipo watch` builds its state on `OfficeStore`. The percent formatter, the health labels, the output-range codec and `storyRef` exist once in client and are used by cli and tui.
- [ ] #5 The TUI reads from the command definitions which commands confirm, as the CLI does.
- [ ] #6 Every colour in the TUI goes through one place that honours `NO_COLOR` and `--no-color`, shown by a test with `NO_COLOR` set. `App`'s key handling is split per mode.
- [ ] #7 From v0.1.0, each contract change raises the minor version. A client that needs newer definitions refuses a daemon with a lower minor, with a message naming both versions. A dated note on 0006 is proposed in the PR for the maintainer's approval.
- [ ] #8 Tests cover a slow read next to a fast one, the read deadline, the log line, and watch on the store.
<!-- AC:END -->
