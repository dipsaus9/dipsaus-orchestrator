---
id: DIPO-23
title: Run the daemon with the PID lock and runtime directory
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 09:27'
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
Outcome: `dipo daemon --foreground` runs one daemon per user, guarded by an `O_EXCL` PID lock with stale handling and a reliable PID identity check, in a checked `0700` runtime directory, with JSON-line logs, after recording the 0006 platform prototype results for the compiled binary.

Context: first daemon story; it also runs the 0006 platform prototype checks and records the results in its implementation notes. The lifecycle states, drain and safe mode were split into DIPO-68 in the M0 review (DIPO-15). Log rotation and `dipo daemon logs` follow in DIPO-64. The prototype results gate DIPO-24: when `ws+unix://` fails in the compiled binary, DIPO-24 serves raw NDJSON frames over the Unix socket instead (M0 review, DIPO-15). The Linux results come from a CI job on `ubuntu-24.04` on a scratch branch that is never merged; the macOS results from the maintainer's machine. The PID identity check is shared: DIPO-44 (host liveness), DIPO-68 and DIPO-70 (stop `--force`) use it. `runDaemon` forms added later: `self-check` (DIPO-17), `sandbox-exec` (DIPO-37), `hook` (DIPO-59), `restore` (DIPO-76), per the 0004 and 0006 amendments of 2026-10-12. References: 0006 decisions 2 (`runDaemon` forms), 3 (anchor and runtime directories), 6 (lock, stale break, post-bind re-read, minute check, start time), 8 (`--no-orphans` refusal), 13 (log format, levels, redaction), "Consequences" (prototype list); 0007 section 1 (database opened only after the post-bind re-read).

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
      check: "(unit) PID identity from `ps` and `/proc/<pid>/stat` fixtures: a start time within 2 s matches, a later one is PID reuse, and a zombie counts as dead."
    - kind: "automated"
      check: "(unit) log redaction of `code`, `token` and `session.token` at every level."
    - kind: "manual"
      check: "run `dipo daemon --foreground` twice in two terminals"
      expect: "the second reports the first as running and exits."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `packages/daemon` exports only `runDaemon(argv)`, which dispatches `--foreground`, `worker-host <run-id>` and `wait-pid <pid>` and rejects an unknown form with a usage message; `cli` calls it for the daemon-side forms only.
- [ ] #2 `<state>` resolves from the passwd home directory per platform (or `DIPO_HOME`), never from `XDG_STATE_HOME`, `TMPDIR` or `XDG_RUNTIME_DIR`, and a warning is logged when `$HOME` differs.
- [ ] #3 The runtime directory is chosen after the lock is held, from the 0006 candidates, rejected when longer than 100 bytes for the host socket path or when `lstat` shows a symlink, another owner or a mode other than `0700`, with a `mkdtemp` fallback; the choice is written to `<state>/runtime.json`.
- [ ] #4 Lock acquisition follows 0006 decision 6 steps 1 to 3: a live daemon is reported, a live but silent one is `unresponsive` after 5 s, a stale record is broken by rename-and-verify at most 3 times; the daemon re-reads `dipo.pid` after binding and exits without opening the database when it is not its own.
- [ ] #5 The database opens only after that re-read; the minute check recreates a missing `dipo.pid` and exits when another live daemon holds it.
- [ ] #6 `platform/process.ts` checks PID identity by start time read with `LC_ALL=C TZ=UTC ps -o lstart=` with a tolerance of 2 s, or from field 22 of `/proc/<pid>/stat` on Linux, and treats a zombie as dead.
- [ ] #7 `runDaemon` refuses to start when `--no-orphans` is in `process.execArgv` or `BUN_OPTIONS`.
- [ ] #8 Logs are JSON lines with `ts`, `level`, `msg`, `component` and `office`/`run` when known, in `<logs>/daemon.log`, also on stderr in foreground; `code`, `token` and `session.token` fields are redacted at every level, and the logger is passed to modules that take one (DIPO-21).
- [ ] #9 Implementation notes record the 0006 prototype results on Bun 1.4.2 in the compiled binary: macOS from the maintainer's machine, Linux from a CI job on `ubuntu-24.04`, including whether `ws+unix://` works.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S08 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
