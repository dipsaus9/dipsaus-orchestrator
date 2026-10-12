---
id: DIPO-23
title: Run the daemon with the PID lock and runtime directory
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 12:26'
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
  - packages/engine/src/index.ts
  - packages/engine/src/platform/socket.ts
  - packages/engine/test/platform/
  - packages/engine/test/log/
  - bun.lock
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

Context: first daemon story; it also runs the 0006 platform prototype checks and records the results in its implementation notes. The lifecycle states, drain and safe mode were split into DIPO-68 in the M0 review (DIPO-15). Log rotation and `dipo daemon logs` follow in DIPO-64. The prototype results gate DIPO-24 and DIPO-25: if `ws+unix://` fails in the compiled binary, the work stops there, this story is parked or blocked with the result, and the maintainer chooses the transport; there is no automatic fallback (maintainer decision D17, DIPO-15). Tests set `DIPO_RUNTIME_DIR` under `DIPO_TMP`, so sockets stay inside the sandboxed temp root. The Linux results come from a CI job on `ubuntu-24.04` on a scratch branch that is never merged; the macOS results from the maintainer's machine. The PID identity check is shared: DIPO-44 (host liveness), DIPO-68 and DIPO-70 (stop `--force`) use it. `runDaemon` forms added later: `self-check` (DIPO-17), `sandbox-exec` (DIPO-37), `hook` (DIPO-59), `restore` (DIPO-76), per the 0004 and 0006 amendments of 2026-10-12. References: 0006 decisions 2 (`runDaemon` forms), 3 (anchor and runtime directories), 6 (lock, stale break, post-bind re-read, minute check, start time), 8 (`--no-orphans` refusal), 13 (log format, levels, redaction), "Consequences" (prototype list); 0007 section 1 (database opened only after the post-bind re-read).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-23/run-daemon-pid-lock-runtime-directory"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) runtime directory choice for each candidate, length limit, squatted directory fallback; `DIPO_RUNTIME_DIR` under `DIPO_TMP` wins over every other candidate."
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
- [x] #1 `packages/daemon` exports only `runDaemon(argv)`, which dispatches `--foreground`, `worker-host <run-id>` and `wait-pid <pid>` and rejects an unknown form with a usage message; `cli` calls it for the daemon-side forms only.
- [x] #2 `<state>` resolves from the passwd home directory per platform (or `DIPO_HOME`), never from `XDG_STATE_HOME`, `TMPDIR` or `XDG_RUNTIME_DIR`, and a warning is logged when `$HOME` differs.
- [x] #3 The runtime directory is chosen after the lock is held, from the 0006 candidates, rejected when longer than 100 bytes for the host socket path or when `lstat` shows a symlink, another owner or a mode other than `0700`, with a `mkdtemp` fallback; the choice is written to `<state>/runtime.json`.
- [x] #4 Lock acquisition follows 0006 decision 6 steps 1 to 3: a live daemon is reported, a live but silent one is `unresponsive` after 5 s, a stale record is broken by rename-and-verify at most 3 times; the daemon re-reads `dipo.pid` after binding and exits without opening the database when it is not its own.
- [x] #5 The database opens only after that re-read; the minute check recreates a missing `dipo.pid` and exits when another live daemon holds it.
- [x] #6 `platform/process.ts` checks PID identity by start time read with `LC_ALL=C TZ=UTC ps -o lstart=` with a tolerance of 2 s, or from field 22 of `/proc/<pid>/stat` on Linux, and treats a zombie as dead.
- [x] #7 `runDaemon` refuses to start when `--no-orphans` is in `process.execArgv` or `BUN_OPTIONS`.
- [x] #8 Logs are JSON lines with `ts`, `level`, `msg`, `component` and `office`/`run` when known, in `<logs>/daemon.log`, also on stderr in foreground; `code`, `token` and `session.token` fields are redacted at every level, and the logger is passed to modules that take one (DIPO-21).
- [x] #9 Implementation notes record the 0006 prototype results on Bun 1.4.2 in the compiled binary: macOS from the maintainer's machine, Linux from a CI job on `ubuntu-24.04`, including whether `ws+unix://` works; if it does not, the story stops there with the result in its notes for the maintainer to choose the transport.
- [x] #10 `DIPO_RUNTIME_DIR` overrides the runtime directory for tests, checked like any other candidate, so every test socket lives under `DIPO_TMP`.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S08 (DIPO-15). Before cutover: built by hand-run agents.

Scope additions: packages/engine/src/platform/socket.ts binds <runtime>/dipo.sock (0004 amendment c: the daemon's Bun.serve listeners go through engine/src/platform) and answers with the daemon's identity, which the lock's step-1 handshake uses until DIPO-24 serves engine.hello there. Engine unit tests live in packages/engine/test/platform/ and packages/engine/test/log/, next to the DIPO-21 tests in packages/engine/test/db/. bun.lock changes because packages/daemon gains a testkit devDependency for its integration test (packages/daemon/test/integration/, per 0017).

Implementation (DIPO-23):
- packages/daemon exports only runDaemon(argv, io?); a form table dispatches --foreground, worker-host <run-id>, wait-pid <pid> and the hidden self-check, and rejects anything else with a usage message (exit 2). New forms (sandbox-exec, hook, restore) are one table entry. worker-host and wait-pid check their argument and then exit 1 with 'not available in this build yet': the host is DIPO-44 and wait-pid DIPO-63. cli sends only 'dipo daemon --foreground|worker-host|wait-pid' to runDaemon, with the arguments after 'daemon'.
- engine/src/platform/paths.ts: <state> and <logs> from os.userInfo().homedir per platform, DIPO_HOME override (logs then in <DIPO_HOME>/logs), $HOME mismatch reported and logged as a warning. Runtime candidates in 0006 order; lingering is read from /var/lib/systemd/linger/<user>. Each candidate: 100-byte check on hosts/run_<ulid>.sock, mkdir 0700 when missing, lstat (symlink, owner, mode 0700); fallback mkdtemp under /tmp, or under DIPO_TMP when it is set so test runs never leave /tmp entries; RuntimeDirError names every rejected path. runtime.json written by temp+rename, mode 0600.
- engine/src/platform/process.ts: start time from /proc/<pid>/stat field 22 plus btime (USER_HZ 100) on Linux, from LC_ALL=C TZ=UTC ps -o stat= -o lstart= -o command= on macOS; 2 s tolerance; zombie (state Z) is dead; kill(pid, 0) first. isDaemonCommand matches 'daemon ... --foreground'.
- engine/src/platform/lock.ts: steps 1 to 3 of 0006 decision 6, 5 s wait (poll 250 ms) before unresponsive, rename-and-verify with link() restore, at most 3 breaks (LockBreakError). An unparsable record that stays unchanged for the wait is treated as stale. verify() is the post-bind re-read; check() is the minute check (recreates a missing record with O_EXCL, reports lost when another live process holds it, takes back a foreign record of a dead process).
- Daemon order: lock, runtime dir, record runtimeDir in dipo.pid, unlink leftover dipo.sock, bind, re-read dipo.pid (exit 1 without opening the database when it is not ours), write runtime.json, open the database. SIGTERM/SIGINT listeners are installed before startup so a signal during startup still cleans up. Clean exit removes dipo.sock then dipo.pid; a daemon that lost the lock leaves the socket path alone. 'already running' exits 0 (launchd SuccessfulExit=false must not restart it), unresponsive exits 1 and points to 'dipo daemon stop --force'.
- engine/src/log: JSON lines with ts, level, msg, component, office/run from child loggers; code, token and session.token redacted at any depth and level; <logs>/daemon.log (dir 0700, file 0600) and stderr in foreground; level from --log-level or DIPO_LOG; the database gets logger.child({component: database}).
- Manual check (compiled binary, macOS, DIPO_HOME/DIPO_RUNTIME_DIR/DIPO_TMP under /tmp): the second 'dipo daemon --foreground' printed 'dipo daemon is already running (pid N, version 0.0.0-dev, socket ...)' and exited 0; a SIGSTOPped daemon was reported unresponsive (about 7 s: one 1 s handshake timeout plus the 5 s wait); SIGTERM removed dipo.pid and dipo.sock.

0006 prototype results (AC #9), Bun 1.4.2, compiled with bun build --compile:
- macOS (maintainer's machine, darwin-arm64, 2026-10-12): WebSocket upgrade on a Bun.serve unix socket with a ws+unix:// client WORKS (also the unix-websocket check of dipo self-check). Socket file mode after bind 0755; removed by server.stop(true) (1.3.5 left it). A second Bun.serve({ unix }) on a live path now FAILS with EADDRINUSE (1.3.5 took the path over); the daemon still unlinks a leftover dipo.sock before binding, and the lock stays the guard. A detached host (setsid, stdio ignore, BUN_OPTIONS removed) survives SIGKILL of its parent: yes. Compiled binaries read BUN_OPTIONS: yes, process.execArgv shows --no-orphans, and a non-detached grandchild was killed when its BUN_OPTIONS=--no-orphans parent was SIGKILLed, so the runDaemon refusal is needed. SQLite 3.51.0.
- Linux (ubuntu-24.04 CI on a scratch branch): NOT RUN. Pushing the scratch branch DIPO-23/prototype-0006 (prototype script plus a push-triggered workflow) was refused by the session's permission check; it needs the maintainer. ws+unix:// in the compiled Linux binary is covered meanwhile by the dipo self-check unix-websocket check in the linux-x64 and linux-arm64 smoke jobs (ubuntu-24.04 runners) of the PR. Still open on Linux: second bind, detached host survival, BUN_OPTIONS, systemd-run --user --scope from a user unit, systemd-inhibit --mode=block with lingering (SSH cannot be reproduced in CI).
- Not run on either platform: the file:// redirect on snap Firefox and Safari (needs a desktop browser; belongs with dipo web).

Linux prototype results (AC #9), compiled Bun 1.4.2 binary on ubuntu-24.04 x64 and ubuntu-24.04-arm, scratch branch DIPO-23/prototype-0006, run 38248948581 (branch deleted afterwards). Identical on both: SQLite 3.53.2; ws+unix:// upgrade and echo works; socket created 0755 and removed on stop; a second Bun.serve bind on a live path fails with EADDRINUSE (as on macOS; ADR 0006 recorded success on 1.3.5); a detached host survives SIGKILL of its parent; compiled binaries read BUN_OPTIONS and --no-orphans there kills orphans, so the runDaemon refusal is needed; systemd-run --user --scope works from a shell and from inside a user unit (DIPO-37); systemd-inhibit --mode=block is refused by polkit ('Access denied') with lingering on, so 0006's retry with --mode=delay and the 'keep-awake not held' status are needed (DIPO-63). Not runnable in CI: systemd-inhibit over SSH and the file:// redirect on snap Firefox and Safari.
<!-- SECTION:NOTES:END -->
