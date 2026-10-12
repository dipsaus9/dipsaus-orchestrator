---
id: DIPO-44
title: Host each worker in a detached process with an event file
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 14:05'
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
  - packages/engine/src/runs/
  - packages/engine/src/platform/line-socket.ts
  - packages/engine/src/db/schema.ts
  - .oxlintrc.json
  - test/lint-boundaries/
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
- [x] #1 The engine spawns the host detached with stdio to files, `BUN_OPTIONS` removed, and records PID, start time, socket path and host protocol version in a new `worker_hosts` table.
- [x] #2 The host spawns the worker from the run's `LaunchPlan` through an injected `Spawn` (DIPO-18), writes the first stdin line, and appends each line as `{ t, ch, data }` to `events.ndjson`.
- [x] #3 The host socket `<runtime>/hosts/<run-id>.sock` accepts a versioned handshake with the run id and the ops write, signal, close stdin, status and watch, and nothing else; a watcher receives `advanced { offset }` after each append.
- [x] #4 When the worker exits, the host kills the worker's process group, so no child of the worker outlives the run, then writes `exit.json` with code, signal, final offset and time, and exits.
- [x] #5 The host contains no budget, gate, git or database code; a lint test fails when `host/` imports those modules.
- [x] #6 The run directory is `0700` and holds `events.ndjson`, `exit.json` and `host.log` capped at 5 MB by dropping the oldest half.
- [x] #7 Liveness checks use the DIPO-23 identity check of PID and start time, where a zombie counts as dead, never socket reachability.
- [x] #8 The host's main function runs in-process in tests with an injected spawn, so only the detach test needs a real child process.
- [x] #9 Delayed host signals (`HostOp` `afterMs`, DIPO-40) are cancelled when the worker exits, so a delayed SIGTERM or SIGKILL never reaches a reused PID; a test covers it.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S28 (DIPO-15). Before cutover: built by hand-run agents.

Implementation (DIPO-44):
- Added references: packages/engine/src/runs/ (engine-side launch and the worker_hosts writes, kept out of host/ so the AC #5 lint holds), packages/engine/src/platform/line-socket.ts (Bun.listen/Bun.connect for the host socket, platform only), packages/engine/src/db/schema.ts (registers migration 3), .oxlintrc.json and test/lint-boundaries/ (the AC #5 lint rule and its test).
- Host: packages/engine/src/host/ (protocol, main, steering, events, host-log, client). The engine writes launch.json (plan, socket path) into the run dir with mode 0600; the host reads and removes it at once because it holds the task message. The host gets the run dir from DIPO_RUN_DIR and its cwd.
- Host socket protocol v1: NDJSON over a Unix stream socket. hello { versions[], run } -> hello { version, run, pid } or refused { error, versions } (run.mismatch, protocol.unsupported, frame.invalid). Ops: write, signal (afterMs), closeStdin, status, watch; anything else gets op.unknown. A watcher gets advanced { offset } after each append. DIPO-59 adds the hook relay as a new op behind the version handshake; WorkerHost.relayHook already writes ch hook lines.
- events.ndjson lines are { t, ch, data } with t in ms since host start; stdout and stderr are split into lines with their newline kept (what interpret expects); the exit is appended as a ch exit line before exit.json (code, signal, finalOffset, at, startError when the spawn failed). exit.json is written by temp+rename.
- At worker exit the host cancels delayed signals (AC #9), then SIGKILLs the worker's process group with signalGroup, which never falls back to the bare PID, waits up to 5 s for output to end, then writes the exit line and exit.json.
- worker_hosts (migration 3): key (office_id, run_id, agent_id), so a reassign can add a second host for the run.
- Finding: Bun 1.4.2 passes --no-orphans to child processes as BUN_FEATURE_FLAG_NO_ORPHANS=1 as well as through BUN_OPTIONS. Removing only BUN_OPTIONS left the host dying with a --no-orphans parent (seen in the CI detach test). detachedEnv strips both, and the daemon's noOrphansActive guard also checks the flag. The client lifecycle (DIPO-70) should strip it too when it starts the daemon. 0006 decision 8 names only BUN_OPTIONS, so the maintainer may want an amendment line.
- Not in this story: the systemd transient scope for hosts under a user unit (0006 decision 8, under supervisors; goes with autostart DIPO-63) and the wiring into a run (DIPO-74).

CI follow-up: on Linux a parent that runs with --no-orphans kills its detached children even with both variables removed (the mechanism does not depend on the child's environment). So the daemon's refusal to run with --no-orphans is the real guard, and stripping the variables keeps a host from turning on --no-orphans for itself. The CI detach test runs its stand-in daemon without --no-orphans and puts both variables only into the environment it hands to the host launch. Without the stripping, that test fails.

Review follow-up: launch.json is removed whenever a host does not start (launchWorkerHost on a spawn error or HostStartError; the worker-host form before every refusal when DIPO_RUN_DIR is absolute). Plan files may not use the run files the engine or host writes (RESERVED_RUN_FILES). LineSplitter holds at most 4 MiB of a line and emits a longer one in pieces, each its own event. The host fixes the hosts directory to 0700 with ensurePrivateDir. A failure while preparing or binding the host socket ends in exit.json with a startError. Retention of events.ndjson belongs to DIPO-4 and DIPO-45. DIPO-70 must strip both BUN_OPTIONS and BUN_FEATURE_FLAG_NO_ORPHANS when it starts the daemon. An ADR 0006 amendment about BUN_FEATURE_FLAG_NO_ORPHANS and the Linux behaviour will be proposed to the maintainer.
<!-- SECTION:NOTES:END -->
