---
id: DIPO-25
title: Reach the daemon from the CLI through the client package
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 09:52'
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
- [ ] #1 The main entry of `packages/client` takes a transport interface, sends `engine.hello` first, matches replies by `requestId`, and exposes typed `command`, `read` and `subscribe` methods built from contract schemas.
- [ ] #2 A lint rule fails verify when the main entry of `packages/client` imports `bun`, a `node:` module or a Bun global; fixtures prove each case is reported.
- [ ] #3 `@dipsaus-orchestrator/client/node` is a second `exports` entry that connects to the socket named in `<state>/runtime.json` with `ws+unix://`, and it is the only client code that uses Bun APIs.
- [ ] #4 On disconnect the client reconnects with backoff from 0.5 s doubling to 5 s on an injected clock, re-subscribes after the last cursor, and re-sends an unanswered command with the same `requestId`.
- [ ] #5 `dipo daemon log-level <level>` and `dipo daemon resume-scheduling` send `daemon.setLogLevel` and `daemon.resumeScheduling` through `client/node` and print the reply; an error prints its code and message and exits 1.
- [ ] #6 With no daemon running, these commands exit non-zero with a message naming `dipo daemon start`; autostart arrives with DIPO-70.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S10 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
