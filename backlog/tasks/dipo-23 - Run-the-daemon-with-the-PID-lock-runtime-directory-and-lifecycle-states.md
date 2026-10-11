---
id: DIPO-23
title: 'Run the daemon with the PID lock, runtime directory and lifecycle states'
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-11 18:49'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-17
  - DIPO-21
references:
  - packages/daemon/
  - packages/engine/src/platform/paths.ts
  - packages/engine/src/platform/process.ts
  - packages/engine/src/platform/lock.ts
  - packages/engine/src/log/
  - packages/cli/src/
documentation:
  - docs/decisions/0006-daemon-and-ipc.md
  - docs/decisions/0007-state-database.md
priority: high
type: feature
ordinal: 23000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo daemon --foreground` runs one daemon per user, guarded by an `O_EXCL` PID lock with stale handling, in a checked `0700` runtime directory, moving through the lifecycle states with a graceful drain, a safe mode after a crash loop, and JSON-line logs.

Context: first daemon story; it also runs the 0006 platform prototype checks and records the results in its implementation notes. Log rotation and `dipo daemon logs` follow in DIPO-64. References: 0006 decisions 2 (`runDaemon` forms), 3 (anchor and runtime directories), 6 (lock, stale break, post-bind re-read, minute check), 7 (states, drain caps, safe mode), 8 (`--no-orphans` refusal), 13 (log format, levels, redaction), "Consequences" (prototype list); 0007 section 1 (database opened only after the post-bind re-read).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

```dipo
branch: "DIPO-23/run-daemon-pid-lock-runtime-directory"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) runtime directory choice for each candidate, length limit, squatted directory fallback."
    - kind: "automated"
      check: "(integration) two starters race for the lock; exactly one runs; a stale record with a dead PID is broken."
    - kind: "automated"
      check: "(integration, CI only) SIGTERM drains and removes `dipo.sock` then `dipo.pid`; three crashes start in `safe`."
    - kind: "manual"
      check: "run `dipo daemon --foreground` twice in two terminals"
      expect: "the second reports the first as running and exits."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `packages/daemon` exports only `runDaemon(argv)`, which dispatches `--foreground`, `worker-host <run-id>` and `wait-pid <pid>`; `cli` calls it for those forms only.
- [ ] #2 `<state>` resolves from the passwd home directory per platform (or `DIPO_HOME`), never from `XDG_STATE_HOME`, `TMPDIR` or `XDG_RUNTIME_DIR`, and a warning is logged when `$HOME` differs.
- [ ] #3 The runtime directory is chosen after the lock is held, from the 0006 candidates, rejected when longer than 100 bytes for the host socket path or when `lstat` shows a symlink, another owner or a mode other than `0700`, with a `mkdtemp` fallback; the choice is written to `<state>/runtime.json`.
- [ ] #4 Lock acquisition follows 0006 decision 6 steps 1 to 3: a live daemon is reported, a live but silent one is `unresponsive` after 5 s, a stale record is broken by rename-and-verify at most 3 times; the daemon re-reads `dipo.pid` after binding and exits without opening the database when it is not its own.
- [ ] #5 The database opens only after that re-read; the minute check recreates a missing `dipo.pid` and drains when another live daemon holds it.
- [ ] #6 States `starting`, `recovering`, `running`, `draining`, `safe` are entered as 0006 decision 7; SIGTERM and SIGINT in foreground drain within 20 s; 3 crashes within 10 minutes start in `safe`.
- [ ] #7 `runDaemon` refuses to start when `--no-orphans` is in `process.execArgv` or `BUN_OPTIONS`.
- [ ] #8 Logs are JSON lines with `ts`, `level`, `msg`, `component` and `office`/`run` when known, in `<logs>/daemon.log`, also on stderr in foreground; `code`, `token` and `session.token` fields are redacted at every level.
- [ ] #9 Implementation notes record the 0006 prototype results on Bun 1.4.2 in the compiled binary on macOS and Linux.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S08 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
