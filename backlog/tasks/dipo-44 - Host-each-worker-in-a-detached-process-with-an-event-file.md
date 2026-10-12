---
id: DIPO-44
title: Host each worker in a detached process with an event file
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 12:31'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-23
  - DIPO-40
  - DIPO-42
references:
  - packages/engine/src/host/
  - packages/engine/src/platform/process.ts
  - packages/engine/src/db/migrations/
  - packages/daemon/src/
  - packages/engine/test/host/
  - packages/engine/src/index.ts
documentation:
  - docs/decisions/0006-daemon-and-ipc.md
  - docs/decisions/0007-state-database.md
  - docs/decisions/0017-testing-strategy-and-configuration.md
priority: high
type: feature
ordinal: 44000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: each run gets a detached worker host, `dipo daemon worker-host <run-id>`, that starts the worker from the launch plan, appends every stdout line and hook payload to `events.ndjson` with byte offsets, takes steering on its own socket, and writes `exit.json` when the worker ends.

Context: re-attach after a daemon restart is DIPO-57; the host already carries what it needs. The host replays recordings through DIPO-42's `FakeProcess` in tests, so this story depends on DIPO-42; the CI-only detach test uses a stub worker script instead of Claude (M0 review, DIPO-15). The `watch` op lets ingestion (DIPO-45) react to new lines without `fs.watch`. References: 0006 decision 8 (host role, socket, exit file, no engine logic, liveness by PID plus start time, `BUN_OPTIONS` removed), decision 3 (100-byte socket path); 0007 section 2 (run directory under `<git-common-dir>/dipo/runs/<run-id>/`, mode `0700`); 0017 section 2 (`ch` envelope reused for event lines).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-44/host-each-worker-detached-process-event"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(integration) the host main run in-process with an injected spawn and a `FakeProcess` writes the event file and `exit.json`; offsets are monotonic; a watcher gets `advanced` after each append."
    - kind: "automated"
      check: "(integration, CI only) with a stub worker script, SIGKILL of the daemon leaves the host and the stub running; the exit file appears later."
    - kind: "automated"
      check: "(integration, CI only) a stub worker that starts a background child leaves no process behind once `exit.json` exists."
    - kind: "automated"
      check: "(unit) steering ops map to stdin writes and signals."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The engine spawns the host detached with stdio to files, `BUN_OPTIONS` removed, and records PID, start time, socket path and host protocol version in a new `worker_hosts` table.
- [ ] #2 The host spawns the worker from the run's `LaunchPlan` through an injected `Spawn` (DIPO-18), writes the first stdin line, and appends each line as `{ t, ch, data }` to `events.ndjson`.
- [ ] #3 The host socket `<runtime>/hosts/<run-id>.sock` accepts a versioned handshake with the run id and the ops write, signal, close stdin, status and watch, and nothing else; a watcher receives `advanced { offset }` after each append.
- [ ] #4 When the worker exits, the host kills the worker's process group, so no child of the worker outlives the run, then writes `exit.json` with code, signal, final offset and time, and exits.
- [ ] #5 The host contains no budget, gate, git or database code; a lint test fails when `host/` imports those modules.
- [ ] #6 The run directory is `0700` and holds `events.ndjson`, `exit.json` and `host.log` capped at 5 MB by dropping the oldest half.
- [ ] #7 Liveness checks use the DIPO-23 identity check of PID and start time, where a zombie counts as dead, never socket reachability.
- [ ] #8 The host's main function runs in-process in tests with an injected spawn, so only the detach test needs a real child process.
- [ ] #9 Delayed host signals (`HostOp` `afterMs`, DIPO-40) are cancelled when the worker exits, so a delayed SIGTERM or SIGKILL never reaches a reused PID; a test covers it.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S28 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
