---
id: DIPO-320
title: >-
  Serve reads concurrently with deadlines, share client rules, build dipo watch
  on the store
status: Done
assignee: []
created_date: '2026-10-22 21:00'
updated_date: '2026-10-30 15:59'
labels:
  - 'tier:L'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-351
references:
  - packages/daemon/src/server.ts
  - packages/engine/src/commands/execute.ts
  - packages/engine/src/reads/execute.ts
  - packages/engine/src/reads/hello.ts
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
Outcome: one slow read no longer freezes a client connection, and every command and read writes one log line with its outcome and duration. The runtime layout rules exist once, for both the engine and the client. `dipo watch` builds on the client store and uses the same formatters as the TUI. The TUI honours NO_COLOR everywhere and reads from the contract which commands need confirmation.

Context:
- **Reads.** `packages/daemon/src/server.ts` awaits reads and subscribes in order on each connection, and no request has a server-side deadline. The command and read executors (`commands/execute.ts`, `reads/execute.ts`) log nothing.
- **Duplicated runtime rules.** Process identity, lock and runtime-record parsing, the state-folder rule and the log-rotation names exist in `engine/src/platform/` and again in `client/src/node/lifecycle/`. A parity test (`test/lifecycle-parity/`) keeps the two in line.
- **`dipo watch`.** `packages/cli/src/watch-command.ts` folds events itself. The CLI and TUI each have their own percent formatting, health labels and output-range codec, and `storyRef` is copied four times. The TUI hard-codes which actions confirm, while the CLI reads `definition.confirm`.
- **TUI.** Direct colour sites in the TUI bypass the NO_COLOR handling of `Colored`, and `App` (`tui/src/app.tsx`) holds the key handling of every mode.
- Trimmed on 2026-10-25: the contract has one version per binary (0014), so the minor-version check is gone from this story, and DIPO-355 removes the versioning. Track 2 of the prune (0003).

```dipo
branch: "DIPO-320/concurrent-reads-shared-client-rules"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(daemon) a slow read next to a fast one answers the fast one first, and a read past its deadline answers timedOut"
    - kind: "automated"
      check: "(cli) dipo watch builds its state on OfficeStore and prints with the shared client formatters"
    - kind: "automated"
      check: "(tui) with NO_COLOR set no frame holds a colour code"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Reads are dispatched concurrently on each connection, keyed by request id. Only subscribes to the same stream stay in order. Each read has a deadline, after which it answers a coded `timedOut`.
- [x] #2 The command and read executors write one structured log line per request: name, request id, office, outcome code and milliseconds.
- [x] #3 The runtime layout rules live in one runtime-free module that both engine and client import, and the parity test is removed.
- [x] #4 `dipo watch` builds its state on `OfficeStore`. The percent formatter, the health labels, the output-range codec and `storyRef` exist once in client and are used by cli and tui.
- [x] #5 The TUI reads from the command definitions which commands confirm, as the CLI does.
- [x] #6 Every colour in the TUI goes through one place that honours `NO_COLOR` and `--no-color`, shown by a test with `NO_COLOR` set. `App`'s key handling is split per mode.
- [x] #7 Tests cover a slow read next to a fast one, the read deadline, the log line, and watch on the store.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Delivered in four PRs. Part 1 (#466): the daemon serves a connection's reads side by side, keyed by request id. At most 32 reads and subscribes run at once per connection; only subscribes and unsubscribes of one stream keep their order. Each read and subscribe has a 90 s deadline that answers request.timedOut, a generic contract code. Every command and read a client sends writes one log line with name, request id, office, the outcome the client got, and milliseconds; the engine's own desk read writes none. Part 2 (#467): the runtime layout rules (folders, dipo.pid, runtime.json, process identity, the detached environment and the log names) live once in the contract's runtime-free runtime-layout.ts, which the engine, the client and testkit import. Paths are normalised before a containment check, and an unknown uid refuses the runtime folder. The lifecycle parity test is removed. Part 3 (#468): dipo watch builds its state on the OfficeStore. The percent formatter, the health words, the output-range codec and storyRef exist once in the client and are used by the CLI and the TUI. Part 4 (#469): the TUI reads from the command definitions which actions confirm, sends every colour through one Colored that honours NO_COLOR and --no-color (tested by a child render with FORCE_COLOR=3), and splits App's key handling per mode. The maintainer approved the ADR changes: 0005 says the daemon serves a connection's frames side by side, a command never waits behind a read or subscribe, request.timedOut is a generic code, and request.reused on a read or subscribe means its id is still running; 0004's contract row now holds the runtime layout, with the parity-test copy in its Replaced list. Follow-up G13: a run can end without a closing event, so dipo watch keeps a 15 s idle check of story.detail, skipping stories a closing event just checked.
<!-- SECTION:FINAL_SUMMARY:END -->
