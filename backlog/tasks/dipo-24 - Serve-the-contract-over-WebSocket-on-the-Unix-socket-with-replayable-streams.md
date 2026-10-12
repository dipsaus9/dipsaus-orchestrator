---
id: DIPO-24
title: Serve the contract over WebSocket on the Unix socket with replayable streams
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 09:52'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-22
  - DIPO-23
  - DIPO-68
references:
  - packages/engine/src/platform/serve.ts
  - packages/engine/src/software-stream/
  - packages/engine/src/reads/
  - packages/daemon/test/
  - packages/daemon/src/
  - packages/engine/src/index.ts
documentation:
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0006-daemon-and-ipc.md
priority: high
type: feature
ordinal: 24000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the daemon serves 0005 frames over WebSocket on `<runtime>/dipo.sock`, answers `engine.hello`, `commands.describe` and `daemon.status`, runs `daemon.*` commands, and streams the software ring buffer and office change logs with replay, heartbeats and reset.

Context: the loopback browser listener stays out of M0. This story starts only once DIPO-23's prototype notes show `ws+unix://` working in the compiled binary; otherwise it is blocked until the maintainer chooses the transport, with no automatic fallback (maintainer decision D17, DIPO-15). `commands.describe` also describes reads (0005 amendment of 2026-10-12) and is built from the DIPO-22 registry. References: 0006 decisions 9 (transport, first frame, software ring buffer of 1000 with a random epoch), 5 (`daemon.status` fields, `daemon.stop`), 14 (frozen surface across majors); 0005 sections 7 (reads, capability flags), 8 (attach, reconnect, `stream.mark` every 15 s, filters, at-least-once), 9 (software-level idempotency in memory), 11 (`contract.unsupported`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-24/serve-contract-over-websocket-unix"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(integration) a `ws+unix://` test client attaches, subscribes, receives a replay then live events."
    - kind: "automated"
      check: "(integration) reconnect with an old epoch gets `stream.resetRequired`."
    - kind: "automated"
      check: "(contract) every frame the server sends in the tests parses with `ServerFrame`."
    - kind: "automated"
      check: "(engine) `engine.recovering` during `recovering` and `scheduling.off` in `safe`."
    - kind: "automated"
      check: "(integration) `commands.describe` lists a registered test read with its schemas and `since`, and leaves out a provisional command."
    - kind: "automated"
      check: "(integration) a DIPO-68 transition reaches a subscribed client as `daemon.state`."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `Bun.serve({ unix })` with `fetch` and `websocket` handlers goes through `engine/src/platform/serve.ts`; one JSON frame per text frame.
- [ ] #2 A connection's first frame must be the `engine.hello` read; any other first frame gets an error reply.
- [ ] #3 `engine.hello` returns engine version, contract version, capability flags, daemon state, office summaries from the registered summary source (empty until DIPO-32 registers one) and the software cursor; a different contract major gets `contract.unsupported` with `{ contract, version }` in `details`.
- [ ] #4 `commands.describe` lists every command and read in the DIPO-22 registry with JSON Schema args and result and `since`, plus `confirm` and `irreversible` for commands; provisional and unimplemented contract entries are absent and have no capability flag.
- [ ] #5 `daemon.status`, `daemon.stop { stopWorkers }`, `daemon.setLogLevel` and `daemon.resumeScheduling` behave as 0006 decisions 5 and 7, using the DIPO-68 states.
- [ ] #6 Every state transition reported by DIPO-68 is emitted as `daemon.state { from, to, reason }` on the software stream.
- [ ] #7 `subscribe` to `software` or `office:<id>` replays entries after the cursor, then sends `stream.mark { caughtUp: true }`, then live events; an old or foreign cursor gets `stream.resetRequired { oldest }`.
- [ ] #8 `stream.mark` is sent every 15 s on an idle subscription; `filter` prefixes drop matching event types.
- [ ] #9 Office commands and reads in `starting` or `recovering` fail with retryable `engine.recovering`, and scheduling commands in `safe` with retryable `scheduling.off`.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S09 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
