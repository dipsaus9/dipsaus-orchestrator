---
id: DIPO-24
title: Serve the contract over WebSocket on the Unix socket with replayable streams
status: Done
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 13:21'
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
  - packages/engine/src/platform/socket.ts
  - packages/engine/src/platform/lock.ts
  - packages/engine/test/software-stream/
  - packages/engine/test/reads/
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
- [x] #1 `Bun.serve({ unix })` with `fetch` and `websocket` handlers goes through `engine/src/platform/serve.ts`; one JSON frame per text frame.
- [x] #2 A connection's first frame must be the `engine.hello` read; any other first frame gets an error reply.
- [x] #3 `engine.hello` returns engine version, contract version, capability flags, daemon state, office summaries from the registered summary source (empty until DIPO-32 registers one) and the software cursor; a different contract major gets `contract.unsupported` with `{ contract, version }` in `details`.
- [x] #4 `commands.describe` lists every command and read in the DIPO-22 registry with JSON Schema args and result and `since`, plus `confirm` and `irreversible` for commands; provisional and unimplemented contract entries are absent and have no capability flag.
- [x] #5 `daemon.status`, `daemon.stop { stopWorkers }`, `daemon.setLogLevel` and `daemon.resumeScheduling` behave as 0006 decisions 5 and 7, using the DIPO-68 states.
- [x] #6 Every state transition reported by DIPO-68 is emitted as `daemon.state { from, to, reason }` on the software stream.
- [x] #7 `subscribe` to `software` or `office:<id>` replays entries after the cursor, then sends `stream.mark { caughtUp: true }`, then live events; an old or foreign cursor gets `stream.resetRequired { oldest }`.
- [x] #8 `stream.mark` is sent every 15 s on an idle subscription; `filter` prefixes drop matching event types.
- [x] #9 Office commands and reads in `starting` or `recovering` fail with retryable `engine.recovering`, and scheduling commands in `safe` with retryable `scheduling.off`.
- [x] #10 The PID lock's step-1 handshake moves to `engine.hello` over `ws+unix://` in the same change that replaces DIPO-23's temporary HTTP identity endpoint on `dipo.sock`, and `bindDaemonSocket`/`probeDaemonSocket` are removed; a test shows a live daemon is reported as running, not unresponsive.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S09 (DIPO-15). Before cutover: built by hand-run agents.

Added references packages/engine/test/software-stream/ and packages/engine/test/reads/: the engine unit tests of the software ring buffer and of engine.hello and the capability flags live next to the other engine tests (packages/engine/test/<area>/).

Implementation (DIPO-24):
- engine/src/platform/serve.ts: serveUnixSocket(path, accept) wraps Bun.serve({ unix, fetch, websocket }); every request is upgraded, plain HTTP gets 426; one text frame per JSON frame, binary frames close with 1003. backpressureLimit 8 MiB with closeOnBackpressureLimit, so a slow client is closed and replays from its cursor (at-least-once); max frame 4 MiB. stop() yields one tick so frames sent in the same tick (the daemon.stop reply) leave, closes every connection with 1001, waits up to 1 s for clients to close, then stops and removes dipo.sock.
- engine/src/platform/socket.ts: bindDaemonSocket/probeDaemonSocket and the HTTP identity endpoint are removed. connectUnixSocket is a minimal ws+unix:// request/reply client for daemon-side use. engine/src/platform/lock.ts helloHandshake: step 1 reads runtime.json, sends engine.hello, then daemon.status, and counts the daemon as running when the status names the record PID; a contract.unsupported hello from another major counts as an answer (frozen surface).
- engine/src/software-stream: SoftwareStream ring buffer (1000 entries, random epoch per start, seqs from 1); since(after) replays or answers stream.resetRequired { oldest } for another epoch, a cursor below the oldest kept entry, or past the head. Only stored software/both event types are accepted, data validated against the contract.
- engine/src/reads/hello.ts: helloFeature(source) registers engine.hello (engine version, contract version, capability flags, daemon state, office summaries from the OfficeSummarySource, software cursor); another major gets contract.unsupported with { contract, version }. Capability flags come from a table of flag -> commands/reads; a flag is offered only when every name is registered and shipped (since), so provisional or unbuilt entries never show up. commands.describe is unchanged (DIPO-22 registry).
- daemon/src/server.ts ContractServer: per connection the first frame must be the engine.hello read; any other first frame gets a not.permitted error reply (an unsubscribe, which has no requestId, closes with 1008). After contract.unsupported only engine.hello, daemon.status and daemon.stop run; everything else gets contract.unsupported. Unparsable JSON closes with 1007; a frame with a requestId that is not a ClientFrame gets args.invalid. Reads and the handshake are taken in order; commands run alongside and reply when done. lifecycleGate: engine.hello, commands.describe and daemon.* always run; other commands and reads get engine.recovering in starting/recovering; work.run gets scheduling.off in safe; in draining no command but daemon.* starts (scheduling.off, retryable). Commands hold lifecycle.beginWork() so the drain waits for them. subscribe: reply { stream, from }, then the replay (500 events per frame, office logs read in pages of 1000 and rendered by the DIPO-22 Renderer), then stream.mark { caughtUp: true }, then live events; on the software stream the current office.summary events follow catch-up. No `after` means from the head. Filters drop stored event types by prefix; stream.mark is never filtered. An idle subscription gets stream.mark every 15 s (injected clock), repeating its position. Office live events: after a command reply with a cursor the server calls notifyOffice(office), and each subscriber pulls from its position; later writers outside commands call notifyOffice too.
- daemon/src/control.ts: controlFeature registers daemon.status (state, reason, pid, version, uptime, socket; loadedOffices [], activeRuns 0, keepAwake { held: false }, upgradePending false, tools {} until DIPO-27/48/63/70), daemon.stop (moves to draining with reason daemon.stop and asks foreground for the drain with stopWorkers; a repeat replies changed false), daemon.setLogLevel (logger.setLevel, changed when the level differs) and daemon.resumeScheduling (lifecycle.resumeScheduling, daemon.notSafe outside safe). Idempotency is the DIPO-22 in-memory request table. emitDaemonStates puts every lifecycle transition on the software stream as daemon.state { from, to, reason }.
- foreground.ts: the software stream is created with the lifecycle; the registry is FEATURES + hello + control (+ ForegroundOptions.features for tests); office commands see the database only after the migrations step opened it; on exit the socket stops (connections closed) before the database closes.
- Tests: in-process ws+unix:// client over a real socket (daemon/test/support) asserts every server frame parses with ServerFrame; handshake, describe, daemon.*, lifecycle gate, software and office replay/reset/filters/heartbeat; real daemon processes: second start reports already running via engine.hello in well under the 5 s unresponsive wait, SIGTERM and daemon.stop reach a subscribed client as daemon.state before the 1001 close.
- Manual check (compiled binary, macOS, DIPO_HOME/DIPO_RUNTIME_DIR/DIPO_TMP under a temp dir): second `dipo daemon --foreground` printed "dipo daemon is already running (pid N, version 0.0.0-dev, socket ...)" and exited 0 in about 0.07 s; plain HTTP on dipo.sock got 426; a ws+unix:// script sent engine.hello, subscribe software and daemon.stop and got the hello, the subscribe reply, the caught-up mark, daemon.state running->draining, the stop reply and close 1001; dipo.pid and dipo.sock were removed.

Interpretations to confirm:
- The error code for a first frame other than engine.hello is not.permitted (0005 lists no dedicated code).
- Scheduling commands are named in daemon/src/server.ts SCHEDULING_COMMANDS (work.run today). work.resume schedules only when it resumes to In Progress, so its story (DIPO-51) checks the lifecycle for that case rather than the name list.
- In draining, commands other than daemon.* get the retryable scheduling.off (DIPO-68 predicate), reads still run until the socket closes.

Review follow-up (PR #36):
- Backpressure: SocketConnection.send reports sent, backpressure or dropped, and buffered() gives the unsent bytes. Bun 1.4.2 drops frames past backpressureLimit (send returns 0) but leaves the connection open, so serve.ts terminates a connection whose send is dropped or whose unsent data passes the limit (8 MiB). Office catch-up is flow-controlled: pages of 100 entries, one frame each, read and rendered only while less than 1 MiB is unsent; the websocket drain handler resumes it, and catch-up and software replay stop as soon as the connection is closed. A slow client therefore pauses its own catch-up instead of growing the daemon buffer; past the limit it is terminated and resumes from its cursor. Tests: daemon/test/integration/backpressure.test.ts (raw socket that stops reading: paused while a fast client gets everything; with a 256 KiB limit it is terminated, nothing more is rendered for it, and a new connection resumes from the same cursor).
- Lock step 1: helloHandshake also requires runtime.json startTimeMs to equal the PID record start time (which acquireLock checks against the live process), so the identity is PID plus start time as in DIPO-23, before the engine.hello/daemon.status exchange. Test for a reused PID with another start time.
- daemon.status placeholder fields and their owning stories: loadedOffices [] (DIPO-27, office loading), activeRuns 0 (DIPO-48/DIPO-74, runs), keepAwake { held: false } (DIPO-63, keep-awake), upgradePending false (DIPO-70, restart and upgrade), tools {} (DIPO-70 AC #3, tool paths resolved at start), webUrl absent (browser listener, after M0).

Follow-up idea (reviewer): an integration test where a paused client resumes reading on the same connection and receives every seq once, in order, then one caughtUp mark; and a platform test pinning Bun's send return codes past backpressureLimit.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Contract over WebSocket on the Unix socket: serve.ts (one JSON frame per text frame, plain HTTP 426, backpressure with send results, termination on drop or past 8 MiB), software stream ring buffer with a random epoch, engine.hello with capability flags for registered non-provisional names, ContractServer (first-frame rule, other-major frozen surface, lifecycle gates, subscribe/replay/reset with stream.mark caughtUp, paced office catch-up, filters, 15 s heartbeat), daemon.* control operations, daemon.state on every lifecycle transition, lock step 1 via engine.hello + daemon.status with pid and start-time identity. Reviewer pass.
<!-- SECTION:FINAL_SUMMARY:END -->
