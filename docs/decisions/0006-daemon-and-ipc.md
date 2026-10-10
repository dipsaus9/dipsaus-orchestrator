# 0006 Daemon lifecycle and IPC transport

Status: Accepted (maintainer, 2026-10-10). Proposed in spike DIPO-3; amends 0004 (applied).

## Context

The engine runs detached so work survives closing a client and runs overnight (0001). One piece of software sits above many isolated offices and keeps the office list (0011). The stack is TypeScript on Bun 1.4, one binary `dipo`, macOS and Linux only, with packages `contract`, `engine`, `daemon`, `client`, `tui` and `cli` (0004). `cli` has one daemon entry that calls `runDaemon`; every other subcommand goes through `client`, and `cli` never imports `engine`.

This ADR decides how the daemon runs and how clients reach it: process model, office registration, start, stop and status, locking, crash recovery, transport and its security, worker survival across restarts, keep-awake, logging, upgrades and autostart. Message shapes, ids, the handshake, capability flags, replay and contract versioning are in 0005 (DIPO-2). The state schema and the office state location belong to DIPO-4, the worker adapter and native session resume to DIPO-5.

Bun facts this ADR relies on, checked 2026-10-10:

- `Bun.listen` and `Bun.connect` accept a `unix` path option [1]. `Bun.serve` accepts `unix` (a socket path, not combinable with `hostname` and `port`) or `hostname`/`port`; `hostname: "127.0.0.1"` listens only locally [2][3]. WebSocket upgrade happens in `fetch` through `server.upgrade(req, { data, headers })`, and request headers are readable there [4].
- Bun's WebSocket client connects over Unix sockets with `ws+unix://`. It is listed in the Bun 1.4 release notes [5]; it may have landed in a late 1.3.x patch. It is absent in 1.3.5 (local test: "Wrong url scheme"). 0004 pins `>=1.4.2`, so it is available.
- Local test on 1.3.5: a second `Bun.serve({ unix })` on a path where a live server listens **succeeds** and takes over the path, and the socket file is created with mode `0755` and left behind after `stop()`. So binding is not a lock, and the directory, not the socket file, must carry access control.
- `Bun.spawn({ detached: true })` calls `setsid()` on POSIX, so the child leads a new session and can outlive the parent. Stdio must be `"ignore"` or files, or it keeps the parent alive [6].
- `--no-orphans` makes Bun exit when its **original parent** dies, and on clean exit it **recursively SIGKILLs all descendants**, on Linux and macOS [5]. Both effects break a detached daemon and workers that outlive it (Decision 8).
- `bun:ffi` is marked experimental, "do not rely on it in production" [7]. This rules out `flock(2)`, `SO_PEERCRED` and `IOPMAssertionCreate` through FFI.
- Linux abstract-namespace sockets ignore file permissions; any process in the network namespace can connect [13]. Without peer credentials (no FFI) they cannot be secured, so they are not used.
- `sun_path` is 104 bytes on macOS and 108 on Linux; a longer path fails with `ENAMETOOLONG` (seen in the local test).

## Options

### Process model

| | A. One daemon for all offices | B. One daemon per office | C. Supervisor plus one engine process per office |
|---|---|---|---|
| Shared limits (plan limits, spend alerts across offices, research idea 6) | Natural | Needs cross-process coordination | Supervisor coordinates |
| Keep-awake, sockets, autostart units | One each | One per office | One each |
| Fault isolation | A crash stops scheduling everywhere (workers keep running, Decision 8) | Full | Full |
| Office list | Owned by the daemon | Needs a separate owner anyway | Owned by the supervisor |
| Complexity | Lowest | Socket sprawl; research section 4 avoids "one process per repository" | Highest: two IPC layers |

### Local client transport

| | Raw NDJSON over `Bun.listen` unix socket | WebSocket over `Bun.serve` unix socket | HTTP/WebSocket on 127.0.0.1 only |
|---|---|---|---|
| Framing | Own line framing | Built in | Built in |
| Same code path as browser clients | No, a second server | Yes, same handler | Yes |
| Access control | Directory permissions | Directory permissions | Token needed even for the TUI |
| Non-JS clients | Easiest (`nc -U`) | Needs a WebSocket library with unix support | Any HTTP client |

### Browser client access

- **Daemon listener**: the daemon opens an opt-in HTTP/WebSocket listener on 127.0.0.1 with a token and serves the web UI bundle.
- **Gateway package**: a separate process bridges browser WebSocket to the daemon socket (as hermes3d's proxy does). Adds a process, a hop and a second lifecycle; it pays off only for remote or LAN access, which is not a goal.

### Single-instance lock

- `flock(2)` through FFI: released by the kernel on death, but needs experimental `bun:ffi` [7].
- Socket bind: not exclusive in Bun (local test above).
- **PID file created with `O_EXCL`**, liveness by PID plus process start time, stale records broken by rename and verified. No FFI.

### Keep-awake

- macOS `caffeinate` child vs `IOPMAssertion` through FFI (experimental, rejected).
- Linux `systemd-inhibit` child vs the logind D-Bus `Inhibit` call (needs a D-Bus client; more code for the same lock).

## Decision

### 1. One daemon serves all offices

Option A. One daemon process per user. Inside it each office is its own engine instance with its own database handle, scheduler and workers; no office code reaches another office's instance. That boundary is kept in code so option C stays possible. Shared limits and spend alerts across offices are read at the daemon level.

### 2. Entry points (amends 0004, see "Amends 0004")

`cli` dispatches on argv:

- **`runDaemon(argv)` entries**, the only forms that run daemon-side code: `dipo daemon --foreground` (the daemon), `dipo daemon worker-host <run-id>` (Decision 8) and `dipo daemon wait-pid <pid>` (Decision 12). `runDaemon` dispatches internally; worker-host reaches the adapter's spawning code through `engine`, imported by `daemon`, never by `cli`.
- **Client subcommands**: `dipo daemon start|stop|restart|status|logs|log-level|resume-scheduling|install|uninstall` and `dipo office open|forget` go through `client`. Process-level steps that cannot use the socket (spawning the daemon, reading `dipo.pid`, signalling an unresponsive PID, calling `launchctl` or `systemctl`) live in a `lifecycle` module of `client`, which imports neither `engine` nor `daemon`.

### 3. Directories

| Purpose | Linux | macOS |
|---|---|---|
| Software state (`<state>`): lock `dipo.pid`, `runtime.json`, office list, crash counter | `~/.local/state/dipo` | `~/Library/Application Support/dipo` |
| Logs | `<state>/logs` | `~/Library/Logs/dipo` |
| Runtime: socket, worker host sockets, `web.json`, `web-open.html` | see below | see below |

`<state>` is the **anchor**. It depends only on the home directory, resolved from the passwd entry for the uid (`os.userInfo().homedir`), not from `$HOME`; daemon and CLI warn when `$HOME` differs. It never depends on `XDG_STATE_HOME`, `TMPDIR` or `XDG_RUNTIME_DIR`, which differ between a shell, a launchd agent, a systemd unit and an SSH session. Every starter and client therefore finds the same lock and the same `runtime.json`. `DIPO_HOME` replaces the anchor, for tests only.

Runtime directory, chosen by the daemon at each start only after it holds the lock (Decision 6), and written to `<state>/runtime.json`, which clients read:

- Candidates in order: `DIPO_RUNTIME_DIR`; Linux `$XDG_RUNTIME_DIR/dipo` when lingering is on (Decision 15), else `/tmp/dipo-<uid>`; macOS `$TMPDIR/dipo` (per user, short), else `/tmp/dipo-<uid>`.
- A candidate is used only if its longest path fits 100 bytes: `hosts/run_<26-char ULID>.sock`, about 40 bytes plus the directory.
- Created `0700`. An existing directory is checked with `lstat` (no symlink follow): it must be a real directory owned by the uid with mode `0700`. Otherwise (for example a squatted `/tmp/dipo-<uid>`) the daemon logs the path and falls back to a fresh `mkdtemp` directory under `/tmp`, recorded in `runtime.json`; if that fails too, it refuses to start and names the squatted path.
- Temp cleaners (macOS `$TMPDIR` aging, systemd-tmpfiles on `/tmp`): the daemon touches its runtime files every hour and checks every minute that `dipo.sock` still exists, rebinding if it was removed.

Everything in state, runtime and logs (office list, crash counter, PID file, web session tokens held in memory, logs) is **operational metadata of the software**, not work state. Work state stays in each office (0001, 0011).

### 4. Office list, open, register and switch

- **Office list**: `<state>/offices.json`, entries of `OfficeId` (`off_<ulid>`, 0005), canonical repository path, display name and time added. Only the daemon writes it, by write-to-temp then rename. Losing it loses no project data.
- The `OfficeId` is also stored in the office's local, gitignored state (location per DIPO-4). Same id at a new path updates the entry (moved repository); a path with a different id is a different office.
- **Register is explicit**: `office.open { path }` (0005), from `dipo office open [path]`, default the current directory. Code checks for a git repository with Backlog.md, initialises office state if missing (M0 office init), assigns the id and adds the entry. No silent discovery: a command in an unregistered repository fails with "not an office, run `dipo office open`". `office.forget` removes the entry and never deletes repository data.
- **Switching is client state.** `office.switch` is a read (0005). The daemon has no "active office"; every office command carries `office`. The CLI resolves it from `--office`, else from the current directory's registered repository. The TUI keeps its own selection, so two clients can watch two offices.
- **Loading is lazy.** An office's engine instance starts on its first command or when recovery finds active runs for it, and unloads after it has been idle with no active runs.

### 5. Start, stop, status

- `dipo daemon start` (client `lifecycle`) spawns `dipo daemon --foreground` with `detached: true`, stdio `"ignore"` and `BUN_OPTIONS` removed from the environment, waits up to 5 s for `engine.hello` on the socket, and prints PID and version. A client command that needs the daemon starts it the same way unless `daemon.autostart = false`.
- `dipo daemon --foreground` runs in the current process; launchd, systemd and debugging use it.
- Operations on a running daemon are contract messages, so commands stay the only way to act (0011): `daemon.status` (read), `daemon.stop { stopWorkers }`, `daemon.setLogLevel { level }`, `daemon.resumeScheduling` (commands). `daemon.stop` drains; by default workers keep running and are re-attached later. With `stopWorkers` they are ended first through the adapter (SIGINT, then SIGTERM, per 0004).
- The only non-contract operations are those the socket cannot serve: start, and `dipo daemon stop --force` for an unresponsive daemon (SIGTERM to the PID from `dipo.pid`, SIGKILL after 10 s, after verifying PID and start time). `dipo daemon logs` reads the log files directly, so it works when the daemon is down; logs are diagnostics, not engine state.
- `dipo daemon status` prints `running` (from `daemon.status`: state and `stateReason`, PID, version, uptime, socket, web URL if on, loaded offices, active runs, keep-awake held or not and why), `not running`, `unresponsive` (PID alive, is `dipo daemon`, socket silent) or `stale` (leftovers cleaned). Exit codes: 0 running, 3 not running, 1 unresponsive. `--json` for scripts.
- The daemon does not exit when idle; scheduled and overnight work need it.

### 6. Single-instance lock and stale processes

`<state>/dipo.pid` in the anchor directory is the lock. It holds PID, process start time (`ps -o lstart= -p <pid>`), version and the runtime directory in use.

1. Read `<state>/dipo.pid`. If its PID is alive with the same start time, read `<state>/runtime.json` and handshake on that socket. Success: a daemon runs; report it.
2. Create `<state>/dipo.pid` with `O_CREAT | O_EXCL`. Success: this process is the instance; the previous holder was verified dead (step 3) or absent. Only now choose the runtime directory (Decision 3), unlink a leftover `dipo.sock` there, bind, write `runtime.json`, serve.
3. `EEXIST`: read the record.
   - PID alive with the same start time and command `dipo daemon`: wait up to 5 s (it may be starting), then report **unresponsive** and point to `dipo daemon stop --force`. Code never kills a live process on a guess.
   - PID dead, or alive with another start time or command (PID reuse): **stale**. Break it atomically: rename `dipo.pid` to `dipo.pid.stale.<own-pid>.<random>` (only one breaker wins), read the renamed file and check it is the record judged stale. If it is, delete it. If not, another starter already replaced it with a live record: restore it with `link()` (fails if the name exists, never clobbers) and remove the renamed name. Go back to step 1, at most 3 times.

On clean exit the daemon removes `dipo.sock`, then `dipo.pid`.

**Stale-break window**: in a rare interleaving of two breakers, the rename-and-verify step can still let two starters each create a record in turn. So right after binding, and before loading any office, the daemon re-reads `<state>/dipo.pid`; if it does not hold its own PID and start time, the daemon unbinds and exits without touching any office. The central database has no further lock; this check is the last guard (0007).

Every minute the daemon checks that `<state>/dipo.pid` still holds its own PID and start time. If the file is missing, it recreates it with `O_EXCL`. If it holds another live daemon, the lock was broken: it logs an error, drains and exits, leaving worker hosts running.

**Second guard, per office**: an engine instance takes an office-level lock when it loads an office (an `O_EXCL` record with PID and start time in the office's local state, stale handling as above) and refuses to load the office while another live process holds it. This protects the office database even if two daemons ever run. Location and form go to DIPO-4.

### 7. Daemon lifecycle states and crash recovery

```
stopped -> starting -> recovering -> running -> draining -> stopped
                            |
                            +-> safe (crash loop: running without scheduling)
```

These are 0005's `DaemonState` values (`stopped` is the absence of a daemon). Every transition emits `daemon.state { from, to, reason }` on the software stream, and `daemon.status` returns the state with its reason.

- **starting**: lock taken, directories checked, logs opened, socket bound. Clients may connect and use `engine.hello` and `daemon.*`; office commands and reads fail with the retryable `engine.recovering` (0005) until `running` or `safe`.
- **recovering**: run office database migrations (DIPO-4), then for each office with active runs: re-attach or close out worker hosts (Decision 8), then reconcile database, Backlog.md and git per 0001. Scheduling is off; office commands still get `engine.recovering`.
- **running**: scheduling on.
- **draining** (`daemon.stop`, SIGTERM, restart, upgrade): no new work, pending writes finish, clients get `daemon.state` to `draining` and reconnect with backoff, worker hosts are left running. SIGTERM always means this graceful drain; SIGINT likewise in `--foreground`. Draining is capped at 20 s, or 60 s with `stopWorkers` (which waits for workers to end); after the cap the daemon exits anyway, and the next start recovers as after a crash.
- **safe**: after 3 crashes within 10 minutes (counter in `<state>`, reset after 10 minutes of stable running), start with scheduling off; reason "crash loop". Office commands and reads work, but commands that would schedule work (`work.run`, resume to In Progress) fail with the retryable `scheduling.off` (0005). `daemon.resumeScheduling` leaves `safe`. This stops a crash loop from spawning workers all night.

A crash is detected on next start by a stale `dipo.pid`. Recovery is the same as after a clean stop, because state lives in office databases and worker host files, not in daemon memory. Without a supervisor, the next client command restarts the daemon; with autostart (Decision 15), launchd or systemd does.

A run whose worker died while the daemon was down is decided by code from its caps: resume the native session if DIPO-5 supports it and budget remains, otherwise park (open question 3).

### 8. Workers survive a daemon restart (research idea 8)

The daemon never owns a worker process directly. Each run gets a **worker host**, `dipo daemon worker-host <run-id>`, spawned with `detached: true`, stdio to files and `BUN_OPTIONS` removed.

- The host starts the worker through the adapter (for Claude: `claude -p --output-format stream-json`) and appends every event line to the run's event file with a monotonic byte offset.
- It listens on `<runtime>/hosts/<run-id>.sock` for steering only: write to the worker's stdin, send a signal, report status. The protocol is tiny, versioned and separate from the client contract.
- When the worker exits, the host writes an exit file (code, signal, final offset, time) and exits. It has no budgets, gates or other engine logic.
- Per run the office database records host PID, host start time, host socket, host protocol version and the last processed offset. **The processed offset advances in the same SQLite transaction as the facts and change-log entries derived from those events** (0005 section 6), so a crash can neither skip nor double-apply events.
- Run file layout is provisional until DIPO-4: `runs/<run-id>/events.ndjson`, `exit.json` and `host.log` in the office state directory.

**Liveness is PID plus start time**, never socket reachability. Re-attach on recovery, per active run:

- Host alive, socket answers the handshake with the run id: catch up from the processed offset, then follow live with steering.
- Host alive, socket gone or not answering: **follow-only** mode. Tail the event file and wait for the exit file; steering is unavailable and shown as such.
- Host dead with exit file: process the remaining events and the exit.
- Host dead without exit file: the run is `interrupted`.
- During recovery, and for parked or interrupted runs, the engine **never starts a new host for a run whose old host PID is alive**; it follows the old one until its exit file appears.

The same rule holds in normal operation:

- `work.reassign` stops the old agent through the adapter (via its host) and waits up to 30 s (proposed default, same as 0005) for the old host's exit file. If it appears, a new host starts for the new agent. If not, the command fails with the retryable `run.hostAlive` (0005 section 10) and no new host starts.
- `work.resume` of a parked story back to In Progress or In Review fails with `run.hostAlive` while an old host PID for that story is alive.
- A story that reconcile observes as `Removed` (vanished from Backlog.md or identity changed, 0005 section 2) can come from any state: it is an observation, not an engine transition. If it has a live run, the engine stops the worker through its host as `work.stop` would, and starts nothing new.
- `work.pause`, `work.steer` and `work.answer` go to the live host and never start a new one.

While the daemon is down only the worker's own CLI limits apply (DIPO-5). After catching up, the engine checks the run's caps against the replayed events and stops the worker if it is over.

**`--no-orphans` is never active in the daemon chain.** Its "exit when the original parent dies" would kill a daemon when the `dipo daemon start` client exits, and its recursive SIGKILL on clean exit would kill every worker host. Guards: `client` and the daemon remove `BUN_OPTIONS` from the environment of every daemon and host they spawn, and `runDaemon` refuses to start with a clear error when `--no-orphans` is in `process.execArgv` or `BUN_OPTIONS`.

**Under supervisors**: under systemd, worker hosts start in their own transient scope (`systemd-run --user --scope --unit=dipo-run-<id>`), so stopping the daemon's unit does not kill them while the unit keeps the default `KillMode=control-group` [10]. Under launchd, hosts already have their own process group through `setsid`, and the plist sets `AbandonProcessGroup` as a second guard [9].

### 9. Local client transport

Clients talk to the daemon with **WebSocket over the Unix socket**: `Bun.serve({ unix: "<runtime>/dipo.sock", fetch, websocket })` [2][4], and `client` connects with `ws+unix://` [5]. Raw NDJSON was the runner-up and can be added as a second listener if a real client needs it. Cost of the choice: a non-JS client needs a WebSocket library with Unix socket support.

Mapping onto the connection. Frame shapes are 0005's `ClientFrame` and `ServerFrame`:

- One connection per client carries everything. Each WebSocket text frame holds one JSON frame.
- Client to daemon: `auth`, `command`, `read`, `subscribe`, `unsubscribe`. Daemon to client: `reply`, matched by `requestId` and in any order, and `events`, which may hold several events, each routed by its `cursor.stream`.
- **First frame**: on the Unix socket, the `engine.hello` read. On the loopback listener, `auth` first (Decision 11), then `engine.hello`; a connection whose upgrade carried a valid `Authorization: Bearer` header skips `auth`.
- `subscribe` carries 0005's `after` cursor; replay, `stream.mark` and `stream.resetRequired` behave as in 0005 section 8. Office streams replay from the office change log (DIPO-4).
- **Software stream** (office list and daemon events), owned here: an in-memory ring buffer of the last 1000 entries, with a random epoch at every daemon start. A `subscribe` whose `after` has another epoch or is older than the oldest entry gets `stream.resetRequired { oldest }`, so every client re-reads `engine.hello` after a daemon restart. Losing it is harmless; the office list itself is in `offices.json`.
- **Version compatibility follows 0005 section 11**: same contract major works, with capability flags covering minor differences; a different major gets `contract.unsupported`, and Decision 14 applies.

### 10. Browser clients (research section 8)

The **daemon itself** serves browser clients through a second, opt-in listener: `Bun.serve({ hostname: "127.0.0.1", port })` with the same `fetch` and `websocket` handlers, plus the static web bundle once `packages/web` exists. Off by default, started by `dipo web` (enables the listener and opens the browser, Decision 11) or by `web.enabled` in configuration (format per DIPO-14). Port: configured, else a random free port, written to `<runtime>/web.json`. No gateway package now; one may be added for remote viewing, which is not a goal.

### 11. Local security model

In scope: other local users, and web pages in the maintainer's browser (cross-site WebSocket hijacking, CSRF, DNS rebinding). Out of scope: other processes running as the same user; they can already use the Unix socket.

- **Unix socket**: the runtime directory is `0700` and owned by the user. That is the guard, because Bun creates the socket file `0755` (local test) and BSD-derived systems do not enforce socket file modes consistently. No token. No abstract sockets.
- **Loopback listener**:
  - Binds `127.0.0.1` only; the daemon refuses any other `hostname`.
  - **Bootstrap code**: `dipo web` sends `daemon.webBootstrap` (0005 section 4; Unix socket only) and gets `{ url, code }`: a random 128-bit code, **single use**, valid for **60 s**, never put in a command line. The CLI writes a `0600` file `<runtime>/web-open.html` in the `0700` runtime directory that redirects to `<url>#code=<code>` by `location.replace`, a `<meta http-equiv="refresh">` and a plain link (for browsers without JS), and opens `file://<runtime>/web-open.html`. `open`/`xdg-open` and the browser receive only the file path (the pattern Jupyter uses), so other users cannot read the code from the file or `/proc/<pid>/cmdline`. The CLI deletes the file after 60 s.
  - **Fallback**: snap-confined browsers (Ubuntu's default Firefox and Chromium) cannot read files in `$XDG_RUNTIME_DIR` or `/tmp`, and SSH or browser-less sessions cannot open one at all; Jupyter's redirect file hits the same limits [16]. `dipo web --print`, also used automatically when `open`/`xdg-open` fails or a snap or flatpak browser is the default, writes `<url>#code=<code>` to stdout or the TTY, never argv, for the maintainer to paste. Same 60 s single-use code.
  - **Session token**: the page removes the fragment with `history.replaceState` and sends `{ kind: "auth", code }`. The daemon revokes the code on first use and returns a random 256-bit session token in the `auth` reply as `result.session.token` (0005 section 3), the only place the token travels to a browser. The page keeps it in `sessionStorage`, which is scoped to scheme, host and port (cookies ignore the port, so none are used), and sends `{ kind: "auth", token }` on reconnect. Session tokens live only in daemon memory; a daemon restart or 12 h without use revokes them.
  - **Scripts**: `dipo web --session-file <path>` writes a session token to a new `0600` file; scripts send it as `Authorization: Bearer` read from that file or stdin (for example `curl -H @<file>`), never on a command line.
  - **Upgrade checks**, else 403: `Host` exactly `127.0.0.1:<port>` (blocks DNS rebinding). `Origin` present and not exactly `http://127.0.0.1:<port>`: reject. `Origin` absent: accept only with a valid Bearer header. Without Bearer, the first frame must be `auth` within 5 s, else close with 4401. On `auth.failed` the daemon sends the error reply, then closes with 4401 (0005 section 3). Static files need no token; they hold no data. No CORS headers.
  - **Residual risk**: browser history records `#code=<code>` (briefly before `replaceState`, or permanently for a pasted URL), and history may sync to the cloud; the code is then used or expires within 60 s. Browser extensions with access to the page can read the session token from `sessionStorage` and act as the maintainer until it is revoked. Another local web server on a different port is a different origin and cannot read the token.
- Both listeners expose the same commands, and every command passes the engine's own gates; the transport adds no shortcuts.

### 12. Keep-awake while work is active

Work is active while any office has a run with a live worker host or a running verify, or a confirmed batch waiting to start. The daemon holds one assertion for all offices and releases it 2 minutes after work stops.

- **macOS**: spawn `caffeinate -i -w <daemon-pid>` [8]. `-i` prevents idle system sleep and lets the display sleep; `-w` releases the assertion when the daemon dies, so a crash cannot leak it. The daemon kills the child to release early. Closing the lid on battery still sleeps the Mac; `status` says so.
- **Linux**: spawn `systemd-inhibit --what=idle:sleep --mode=block --who=dipo --why="<n> runs active" dipo daemon wait-pid <daemon-pid>` [11]. The lock lasts as long as the wrapped command, and `wait-pid` exits with the daemon, so it cannot leak. polkit may refuse a `block` lock, typically for SSH, inactive or lingering sessions; then the daemon retries once with `--mode=delay` (which only delays sleep briefly), logs a warning, and `status` shows "keep-awake not held: <reason>". Without `systemd-inhibit` (non-systemd distributions) the same warning and status apply.

### 13. Logging

- **Format**: JSON lines with `ts` (ISO 8601 UTC), `level`, `msg`, `component` (`daemon`, `transport`, `office`, `scheduler`, `worker-host`, ...), `office` and `run` when known, plus fields. `dipo daemon logs` renders them for people; there is no second format.
- **Location**: `<logs>/daemon.log`; each worker host writes `host.log` in its run directory. Worker event streams are run data, not logs; retention belongs to DIPO-4.
- **Rotation** by the daemon itself, because launchd does not rotate and journald sees only stderr: at 10 MB, keep 5 files (`daemon.log.1` to `.5`). Host logs are capped at 5 MB by dropping the oldest half.
- **Levels and debug**: `error`, `warn`, `info` (default), `debug`, `trace`. Set by `dipo daemon start --log-level debug`, `DIPO_LOG=debug`, or at runtime with `daemon.setLogLevel` (resets on restart). `--foreground` also writes to stderr, so systemd's journal gets it.
- **Privacy** (research idea 11): prompts, worker output and command bodies appear only at `debug` and `trace`. Fields `code`, `token` and `session.token` are redacted at every level. `daemon.webBootstrap` is excluded from 0005's idempotent reply storage, so a retry gets a new code and no code is ever stored.
- `dipo daemon logs [-f] [--office <id>] [--run <id>] [--level warn]` reads and filters.

### 14. Upgrades while the daemon runs

Replacing the binary on disk does not affect running processes; they keep the old file open.

- Compatibility follows 0005: same contract major works, a different major gets `contract.unsupported`. In both cases a client whose binary version differs from the daemon's prints "daemon runs vX, this binary is vY, run `dipo daemon restart`".
- `dipo daemon restart` detects a mismatch through 0005's frozen minimal surface (section 11): `engine.hello`, its `contract.unsupported` error whose `details` carry the daemon's contract and version, and the `daemon.status` fields `state`, `pid` and `version`. Same major: it sends `daemon.stop`. Different major: it sends **SIGTERM** after verifying PID and start time from `<state>/dipo.pid`; every daemon version treats SIGTERM as the graceful drain of Decision 7 (worker hosts left running). It waits for the PID to exit, then starts the new daemon. `daemon.stop` stays in the frozen surface for scripts and other clients; restart across majors uses the verified-PID SIGTERM because that does not depend on any contract.
- The daemon checks its executable path every 60 s; when the file changed, `daemon.status` reports `upgrade pending`. With `daemon.autoRestartOnUpgrade = true` it drains and restarts itself once no run is in a step that cannot be detached.
- A restart is the normal drain: worker hosts from the old binary keep running. The new daemon steers hosts whose host protocol version it supports and runs the others in follow-only mode (Decision 8), with a warning. The host protocol changes rarely and stays backward compatible for at least one release.
- Office database migrations run in `recovering`, before scheduling.

### 15. Optional autostart

`dipo daemon install` and `dipo daemon uninstall`; nothing is installed unless asked.

- **macOS**: `~/Library/LaunchAgents/dipo.daemon.plist` with `ProgramArguments` `[<binary>, daemon, --foreground]`, `RunAtLoad`, `KeepAlive` with `SuccessfulExit = false` (restart only after a crash), `AbandonProcessGroup = true` and `ExitTimeOut = 75` (above the 60 s drain cap) [9], loaded with `launchctl bootstrap gui/<uid>`.
- **Linux**: `~/.config/systemd/user/dipo.service` with `ExecStart=<binary> daemon --foreground`, `Restart=on-failure`, `TimeoutStopSec=75` (above the drain cap) [10], `WantedBy=default.target`, then `systemctl --user enable --now dipo`.
- **Linux without lingering**: the user manager stops at logout [12], and with logind's `KillUserProcesses` user processes are killed then too. That ends the daemon **and the worker hosts**, with or without the unit. `install` and `status` check `loginctl show-user --property=Linger` and warn; `install` explains `loginctl enable-linger` but does not run it.
- When installed, `dipo daemon start/stop/restart` go through `launchctl` or `systemctl --user`, so the supervisor and the CLI never fight.
- `install` writes the binary's absolute path; after moving the binary, run `install` again (`status` warns when the path is gone).

## Amends 0004 (approved 2026-10-10, applied)

This ADR changes accepted decisions in 0004. The maintainer approved these replacements on 2026-10-10 and they are applied in 0004.

**(a) Entry points.** `runDaemon(argv)` gets three hidden forms, and lifecycle subcommands under `dipo daemon` become client subcommands. Replace 0004's boundary bullet:

> - `cli` is the only package that imports both `daemon` and `tui`, because the single binary contains both. It has exactly one daemon entry: `<bin> daemon` calls `runDaemon`, the only export of `daemon`. Every other subcommand, including `<bin> tui`, goes through `client` over IPC. `cli` never imports `engine`; the oxlint rule forbids it.

with:

> - `cli` is the only package that imports both `daemon` and `tui`, because the single binary contains both. Every form that runs daemon-side code (`<bin> daemon --foreground`, `<bin> daemon worker-host <run-id>`, `<bin> daemon wait-pid <pid>`) calls `runDaemon(argv)`, the only export of `daemon`, which dispatches internally. Every other subcommand, including `<bin> tui` and the lifecycle subcommands `<bin> daemon start|stop|restart|status|logs|...`, goes through `client`; process-level steps (spawning the daemon, signalling a verified PID, `launchctl`/`systemctl`) live in `client`'s `lifecycle` module (0006). `cli` never imports `engine`; the oxlint rule forbids it.

**(b) `--no-orphans` is no longer a reason for Bun 1.4 in the daemon chain; `ws+unix://` is.** Replace the end of 0004's tooling row "1.4 is needed for child-process stream backpressure, the `Bun.spawn` `terminal` (PTY) option and `--no-orphans` [6]" with:

> 1.4 is needed for child-process stream backpressure, the `Bun.spawn` `terminal` (PTY) option and the WebSocket client's `ws+unix://` support [6]. `--no-orphans` must not be active for the daemon or worker hosts: it exits when the original parent dies and SIGKILLs all descendants on clean exit (0006).

**(c) The Node-fallback bound widens.** `client` now uses `Bun.spawn` (detached daemon start), signals and the Bun-only `ws+unix://` client. Replace 0004's consequence "Bun touchpoints outside the platform module: `bun:test`, Bun workspaces and `bun.lock`, and `bun build --compile`. A move to Node replaces these three plus the platform module." with:

> - Bun touchpoints outside the platform module: `bun:test`, Bun workspaces and `bun.lock`, `bun build --compile`, and `client`'s `lifecycle` and transport modules (`Bun.spawn`, signals, `ws+unix://`; 0006). The daemon's `Bun.serve` listeners and worker-host spawns go through `engine/src/platform`. A move to Node replaces these plus the platform module; Node's `ws` package supports `ws+unix://`, so the transport change stays small.

## Consequences

- One process, one socket, one keep-awake assertion and one office list for all offices. A daemon bug can stop scheduling in every office; running workers are not affected, and recovery is routine because no state lives only in memory.
- Worker hosts add a process per run and a second small protocol, the cost of research idea 8 and of restarting or upgrading the daemon during an overnight run.
- No FFI: lock by `O_EXCL` PID file, keep-awake by child processes. Platform specifics live in `engine/src/platform` and, for start and signalling, in `client`'s `lifecycle` module.
- Non-JS clients need WebSocket over a Unix socket, or the token-protected loopback listener. The web UI is served by the daemon; no extra package or process until remote access is a goal.
- M0 stories that follow: daemon entry and states; lock and stale handling (anchor lock; no office lock, 0007); transport, frame mapping and the software stream ring buffer (with DIPO-2); office list and `office open/forget`; worker host and re-attach (with DIPO-4 and DIPO-5); keep-awake; logging; `daemon install`. The loopback listener can wait until a browser client exists.
- Prototype in the first implementation story, on Bun 1.4.2 inside the compiled binary, on both platforms: WebSocket upgrade on a `Bun.serve` unix socket with a `ws+unix://` client; `Bun.serve` unix bind on an existing path (seen succeeding on 1.3.5); a detached worker host surviving SIGKILL of the daemon; whether compiled binaries read `BUN_OPTIONS`; `systemd-run --user --scope` from a daemon under a user unit; `systemd-inhibit --mode=block` acceptance by polkit over SSH and with lingering; the `file://` redirect on snap Firefox and on Safari.

## Open questions for the maintainer

1. **One daemon for all offices — answered 2026-10-10: yes** (Decision 1).
2. **Opening offices — answered 2026-10-10: both.** `dipo office open <path>` works from anywhere; running `dipo` inside a Backlog.md project that is not yet an office asks once to open it (interactive clients only, never in scripts). No background scanning or auto-registration.
3. **Interrupted runs — answered 2026-10-10 (via 0005): new park reason `interrupted`**, alongside `stopped`; `resume` continues or restarts the run.
4. **Client autostart — answered 2026-10-10: yes.** Any client command starts the daemon when it is not running; `dipo daemon stop` stops it.
5. **Keep-awake scope — answered 2026-10-10: idle sleep only, as Claude Code does** (`caffeinate -i` tied to the daemon with `-w <pid>`, held only while work is active; `systemd-inhibit --what=idle:sleep` on Linux). Closing the lid still sleeps the machine. Unlike the behaviour reported in anthropics/claude-code#64522, the assertion is released as soon as no work is active.
6. **Auto-restart on upgrade — answered 2026-10-10: off.** Clients show that a new version is ready; the maintainer restarts with `dipo daemon restart` when it suits.
7. **Browser listener — answered 2026-10-10: off by default for now**, started by `dipo web`. To be revisited when a web or 3D client exists (an office setting could keep it on).
8. **Amendments to 0004 — approved 2026-10-10** and applied to 0004.

## Sources

1. Bun reference, `UnixSocketOptions` and `UnixSocketListener`. https://bun.com/reference/bun/UnixSocketOptions ; https://bun.com/reference/bun/UnixSocketListener
2. Bun reference, `Serve.UnixServeOptions` ("listens on a unix socket instead of a port. Cannot be used with hostname+port"). https://bun.com/reference/bun/Serve/UnixServeOptions
3. Bun reference, `Serve.HostnamePortServeOptions.hostname` (`"127.0.0.1"`: only listen locally). https://bun.com/reference/bun/Serve/HostnamePortServeOptions/hostname
4. Bun docs, WebSockets (`server.upgrade`, `data`, headers). https://bun.com/docs/runtime/http/websockets
5. Bun blog, "Bun 1.4" (`--no-orphans`; WebSocket client `ws+unix://`; `unix:` in `Bun.serve`). https://bun.com/blog/bun-v1.4
6. Bun reference, `Spawn.BaseOptions.detached` (`setsid()`, stdio note). https://bun.com/reference/bun/Spawn/BaseOptions/detached
7. Bun docs, FFI ("experimental ... do not rely on it in production"). https://bun.com/docs/runtime/ffi
8. caffeinate(8) (`-i`, `-s` AC only, `-w` release on process exit). https://ss64.com/mac/caffeinate.html
9. launchd.plist(5) (`AbandonProcessGroup`, `KeepAlive`). https://leancrew.com/all-this/man/man5/launchd.plist.html
10. systemd.kill(5) (`KillMode`; `process` not recommended). https://www.mankier.com/5/systemd.kill
11. systemd-inhibit(1) (lock held for the wrapped command's lifetime; `--what`, `--mode`). https://www.mankier.com/1/systemd-inhibit
12. loginctl `enable-linger`: user manager starts at boot and keeps running after logout. https://oneuptime.com/blog/post/2026-03-17-use-loginctl-enable-linger-rootless-podman/markdown
13. unix(7) (abstract sockets: permissions have no meaning). https://www.man7.org/linux/man-pages/man7/unix.7.html
14. Local tests on Bun 1.3.5, macOS arm64, 2026-10-10: `ws+unix://` rejected; second `Bun.serve({ unix })` on a live path succeeds; socket created `0755` and left after `stop()`; long path fails with `ENAMETOOLONG`.
15. ADR 0005 (DIPO-2), command and event model: envelopes, ids, replay, versioning. Research ideas 1, 6, 8, 10, 11; sections 4 and 8: `docs/research/2026-10-comparable-tools.md`.
16. jupyter/jupyter_core#191: the browser cannot open Jupyter's redirect file (snap Firefox, WSL, Crostini); workaround `use_redirect_file=False`. https://github.com/jupyter/jupyter_core/issues/191

## Amendments

- 2026-10-10, decision 0007 (maintainer): one central state database `<state>/dipo.db` for all offices, every office-scoped row keyed by `OfficeId`. The office list is a table in it and `<state>/offices.json` is dropped (decisions 3, 4 and 9). Engine instances share the daemon's one connection through office-scoped handles (decision 1). The per-office lock is dropped; the PID lock covers the file (decision 6). Migrations run once for the file in `recovering`, before any office (decision 7). The repository keeps only `<git-common-dir>/dipo/` with the `office.json` marker and run directories.
