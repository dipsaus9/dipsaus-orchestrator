---
id: DIPO-25
title: Reach the daemon from the CLI through the client package
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 13:42'
labels:
  - 'tier:M'
  - test-before-merge
milestone: m-0
dependencies:
  - DIPO-24
references:
  - packages/client/
  - packages/cli/src/
  - .oxlintrc.json
  - test/lint-boundaries/
  - packages/daemon/src/server.ts
  - packages/cli/package.json
  - packages/cli/tsconfig.json
  - bun.lock
  - test/state-dir/
documentation:
  - docs/decisions/0004-language-and-runtime.md
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0006-daemon-and-ipc.md
  - docs/decisions/0009-tui.md
priority: high
type: feature
ordinal: 25000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `packages/client` gives every UI a runtime-free typed protocol core with reconnect and request ids, its `client/node` entry adds the Unix-socket transport, and `dipo daemon log-level` and `dipo daemon resume-scheduling` reach a running daemon through it.

Context: `cli` never imports `engine`; everything here goes through `client`. The client splits in two entries (0004 and 0006 amendments of 2026-10-12): the main entry is runtime-free (frames, request matching, typed methods, reconnect, subscriptions, and later the `OfficeStore` of DIPO-53), so a future web client can reuse it with a browser transport; `@dipsaus-orchestrator/client/node` holds the Unix-socket transport and, from DIPO-70, the `lifecycle` module. Starting, stopping, restarting and reporting the daemon and autostart were split into DIPO-70 in the M0 review (DIPO-15). The transport is `ws+unix://`; if DIPO-23's prototype shows it failing in the compiled binary, this story is blocked until the maintainer chooses the transport (maintainer decision D17, DIPO-15). References: 0006 decision 2 (client subcommands); 0005 section 9 (retry with the same `requestId`); 0009 section 7 (backoff 0.5 s doubling to 5 s); 0004 boundary rules and the 2026-10-12 amendment.

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-25/reach-daemon-from-cli-through-client"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(integration) client against a daemon in a temp `DIPO_HOME`: hello, command, disconnect, reconnect and replay without duplicates."
    - kind: "automated"
      check: "(unit) the core with a fake transport re-sends an unanswered command with the same `requestId` after a reconnect, on the manual clock."
    - kind: "automated"
      check: "(unit) lint fixtures: a `node:fs` import and a `Bun.connect` call in the client core are each reported."
    - kind: "manual"
      check: "with `dipo daemon --foreground` running in one terminal, run `dipo daemon log-level debug` in another, then stop the daemon and run it again"
      expect: "the first call prints the new level and the daemon's stderr shows `debug` lines; with the daemon stopped the command exits non-zero with a message naming `dipo daemon start`."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The main entry of `packages/client` takes a transport interface, sends `engine.hello` first, matches replies by `requestId`, and exposes typed `command`, `read` and `subscribe` methods built from contract schemas.
- [x] #2 A lint rule fails verify when the main entry of `packages/client` imports `bun`, a `node:` module or a Bun global; fixtures prove each case is reported.
- [x] #3 `@dipsaus-orchestrator/client/node` is a second `exports` entry that connects to the socket named in `<state>/runtime.json` with `ws+unix://`, and it is the only client code that uses Bun APIs.
- [x] #4 On disconnect the client reconnects with backoff from 0.5 s doubling to 5 s on an injected clock, re-subscribes after the last cursor, and re-sends an unanswered command with the same `requestId`.
- [x] #5 `dipo daemon log-level <level>` and `dipo daemon resume-scheduling` send `daemon.setLogLevel` and `daemon.resumeScheduling` through `client/node` and print the reply; an error prints its code and message and exits 1.
- [x] #6 With no daemon running, these commands exit non-zero with a message naming `dipo daemon start`; autostart arrives with DIPO-70.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S10 (DIPO-15). Before cutover: built by hand-run agents.

Implementation (DIPO-25):
- Main entry `packages/client/src/` is the runtime-free core: `DipoClient` takes a `Transport` (text frames only), sends `engine.hello` first on every connection, matches replies by `requestId`, and has typed `command(definition, args)`, `read(definition, args)` and `subscribe(stream, ...)` that validate args and results against the contract schemas. Engine errors are returned as values; client-side failures throw `ClientError` (`client.unreachable`, `client.closed`, `client.invalidArgs`, `client.invalidReply`, or the engine code of a failed hello such as `contract.unsupported`). Request ids are ULIDs from the injected clock plus Web Crypto.
- Reconnect: 0.5 s doubling to 5 s on the injected clock, reset after a successful hello; re-subscribes after the last stored cursor, re-sends every unanswered command and read with its original `requestId` after the new hello; drops stored events it already has (derived events exempt); a refused subscribe (`stream.resetRequired`) ends the subscription through `onEnded`. Only the first `connect()` fails fast (`client.unreachable`, 5 s timeout); later losses reconnect.
- `@dipsaus-orchestrator/client/node` (second `exports` entry, `src/node/`): `unixSocketTransport` (`ws+unix://`), `stateDir` and `readRuntimeInfo` for `<state>/runtime.json`, `systemClock`, and `connectToDaemon`, which throws `DaemonNotRunningError` when there is no record or nothing answers on its socket. Stale-record checks against `dipo.pid` stay with DIPO-70.
- Lint (`.oxlintrc.json`): `packages/client/src/**` bans `bun`, `bun:*`, `node:*` imports and the `Bun`, `process`, `Buffer` and `require` globals; `packages/client/src/node/**` lifts that and keeps the engine/daemon and timer bans; `src/node/clock.ts` is the one file allowed real time. Fixtures and `test/lint-boundaries/lint-client-core.test.ts` prove each case.
- CLI: `dipo daemon log-level <level>` and `dipo daemon resume-scheduling` (`packages/cli/src/daemon-commands.ts`) print the reply; an engine error prints `dipo: <code>: <message>` and exits 1; no daemon prints `dipo: no daemon is running (...). Start it with \`dipo daemon start\` (until that exists: \`dipo daemon --foreground\`).` and exits 1; usage errors exit 2; a 10 s reply deadline covers a daemon that vanishes mid-command and prints `dipo: the daemon did not answer within 10 s.` (no start hint).
- Daemon: the contract server logs `connection opened`, `connection closed` and `frame received` (kind, name, stream, requestId, never args) at debug, so the manual test can see `debug` lines (`packages/daemon/src/server.ts`, added to References).
- Tests: `packages/client/test/unit/client.test.ts` (fake transport, manual clock: handshake, reply matching, backoff sequence, same-requestId re-send, re-subscribe after the last cursor, duplicate drop, reset); `packages/client/test/integration/daemon.test.ts` (a real `dipo daemon --foreground` in a temp DIPO_HOME started in `safe` from a seeded crash loop: hello, command, dropped connection, `daemon.state` replayed once after reconnect, and the CLI subcommands as processes, including after the daemon stopped); `packages/cli/src/daemon-commands.test.ts`.
- Deviations: none from the ACs. Not-running exits 1 (AC #6 asks non-zero; 0006's exit 3 is for `dipo daemon status`). `dipo daemon start` itself arrives with DIPO-70; until then start the daemon with `dipo daemon --foreground`. `stateDir` repeats the daemon's anchor rule because `client` may not import `engine`; `test/state-dir/state-dir.test.ts` runs both on the same inputs.

Maintainer test (macOS, uses a throwaway state directory so your real dipo state is untouched):

Build the branch once:
    git fetch origin && git checkout DIPO-25/reach-daemon-from-cli-through-client
    bun install && bun run build

Terminal 1 (daemon):
    export T=/tmp/dipo-test; rm -rf "$T"; mkdir -p "$T"
    export DIPO_HOME=$T/state DIPO_RUNTIME_DIR=$T/run DIPO_TMP=$T
    ./dist/dipo daemon --foreground
Expect JSON log lines on stderr ending with `"msg":"daemon state" ... "to":"running"`.

Terminal 2 (CLI), same repository directory:
    export T=/tmp/dipo-test DIPO_HOME=/tmp/dipo-test/state DIPO_RUNTIME_DIR=/tmp/dipo-test/run DIPO_TMP=/tmp/dipo-test
    ./dist/dipo daemon log-level debug; echo "exit $?"
Expect `daemon log level: debug (until the daemon restarts)` and `exit 0`. Terminal 1 shows `"msg":"log level changed"` and then `"level":"debug"` lines such as `"msg":"connection closed"`.
    ./dist/dipo daemon log-level debug; echo "exit $?"
Expect `daemon log level: debug (unchanged)` and `exit 0`; terminal 1 shows debug lines `connection opened`, `frame received` (`engine.hello`, `daemon.setLogLevel`), `connection closed`.
    ./dist/dipo daemon resume-scheduling; echo "exit $?"
Expect `dipo: daemon.notSafe: Scheduling is not off: the daemon is running, not safe.` and `exit 1`.

Stop the daemon: Ctrl-C in terminal 1 (expect `"msg":"daemon stopped"`). Then in terminal 2:
    ./dist/dipo daemon log-level debug; echo "exit $?"
    ./dist/dipo daemon resume-scheduling; echo "exit $?"
Expect for both `dipo: no daemon is running (nothing answers on /tmp/dipo-test/run/dipo.sock). Start it with \`dipo daemon start\` (until that exists: \`dipo daemon --foreground\`).` and `exit 1`.

Optional, resume from safe mode: in terminal 1 seed a crash loop and start again:
    NOW=$(($(date +%s)*1000)); printf '{"version":1,"running":{"pid":999999,"startTimeMs":1},"crashes":[%d,%d]}\n' $((NOW-120000)) $((NOW-60000)) > $DIPO_HOME/crashes.json
    ./dist/dipo daemon --foreground
Expect a `"to":"safe","reason":"crash loop"` line. In terminal 2:
    ./dist/dipo daemon resume-scheduling; echo "exit $?"
Expect `scheduling resumed; daemon state: running` and `exit 0`; terminal 1 shows `"from":"safe","to":"running","reason":"scheduling resumed"`. Stop with Ctrl-C, then `rm -rf /tmp/dipo-test`.

References added: packages/daemon/src/server.ts (debug log lines the manual test expects; the server had none), packages/cli/package.json and packages/cli/tsconfig.json (testkit as a dev dependency for the CLI tests), bun.lock (zod and testkit links for client and cli).

Review fixes (PR #38): the not-running hint names the foreground fallback until DIPO-70; the reply-timeout message has no start hint; the client core lint also bans `globalThis`/`self`/`window` access to `Bun`, `process`, `Buffer`, `require` and the timers; `test/state-dir/state-dir.test.ts` (added to References) checks client and daemon resolve the same `<state>`.

Follow-up for DIPO-53: a liveness deadline for long-lived clients (treat a connection as dead when no frame or `stream.mark` heartbeat arrives within a deadline, then reconnect). The CLI has its 10 s reply deadline; the TUI needs the liveness check.
<!-- SECTION:NOTES:END -->
