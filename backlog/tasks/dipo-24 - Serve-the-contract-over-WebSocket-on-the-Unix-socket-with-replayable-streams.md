---
id: DIPO-24
title: Serve the contract over WebSocket on the Unix socket with replayable streams
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-11 18:49'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-22
  - DIPO-23
references:
  - packages/daemon/src/transport/
  - packages/engine/src/platform/serve.ts
  - packages/engine/src/software-stream/
  - packages/engine/src/reads/
  - packages/daemon/test/
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

Context: the loopback browser listener stays out of M0. References: 0006 decisions 9 (transport, first frame, software ring buffer of 1000 with a random epoch), 5 (`daemon.status` fields, `daemon.stop`), 14 (frozen surface across majors); 0005 sections 7 (reads, capability flags), 8 (attach, reconnect, `stream.mark` every 15 s, filters, at-least-once), 9 (software-level idempotency in memory), 11 (`contract.unsupported`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

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
      check: "(engine) `engine.recovering` during `recovering`."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `Bun.serve({ unix })` with `fetch` and `websocket` handlers goes through `engine/src/platform/serve.ts`; one JSON frame per text frame.
- [ ] #2 A connection's first frame must be the `engine.hello` read; any other first frame gets an error reply.
- [ ] #3 `engine.hello` returns engine version, contract version, capability flags, daemon state, office summaries and the software cursor; a different contract major gets `contract.unsupported` with `{ contract, version }` in `details`.
- [ ] #4 `commands.describe` lists every command the engine implements with JSON Schema args and result, `confirm`, `irreversible` and `since`; unimplemented contract commands are absent and have no capability flag.
- [ ] #5 `daemon.status`, `daemon.stop { stopWorkers }`, `daemon.setLogLevel` and `daemon.resumeScheduling` behave as 0006 decision 5 and 7.
- [ ] #6 `subscribe` to `software` or `office:<id>` replays entries after the cursor, then sends `stream.mark { caughtUp: true }`, then live events; an old or foreign cursor gets `stream.resetRequired { oldest }`.
- [ ] #7 `stream.mark` is sent every 15 s on an idle subscription; `filter` prefixes drop matching event types.
- [ ] #8 Office commands and reads in `starting` or `recovering` fail with retryable `engine.recovering`.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S09 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
