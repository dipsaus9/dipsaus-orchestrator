# 0005 Engine interface and process

Status: accepted. First written 2026-10-10 (spikes DIPO-2 and DIPO-3). Rewritten 2026-10-24 for the simplified design; it now also holds the daemon and its transport (former 0006). The research behind the rewrite is in `docs/research/2026-10-24-simplification-audit.md`.

## Decision in short

The engine is headless. Clients act only through **commands**, learn only through **reads** and **events**, and never derive a status themselves. One **daemon** per user serves every office. It talks to clients with WebSocket over a Unix socket, and it runs each worker session through a detached **worker host**, so a daemon restart never kills a running session. Client and daemon ship in one binary and speak one contract version.

## Part 1. The contract

### 1. Three kinds of message

| Kind | Direction | Changes facts | Reply |
|---|---|---|---|
| Command | Client to engine | Yes | Exactly one |
| Read | Client to engine | Never | Exactly one |
| Event | Engine to client | No; reports facts already stored | None |

A command writes its facts and their change-log entries in one transaction, then replies. Effects that take time, such as a running worker, arrive later as events. No client reads engine tables, imports `engine` or computes status: health, columns, budget shares and what waits on the maintainer all come ready from the engine.

### 2. Ids

Engine-made ids are a prefix plus a ULID: `off_` (office), `sto_` (story key), `run_`, `agt_` (one session), `gat_` (gate), `qst_` (question), `prp_` (proposal). A `StoryId` is the Backlog.md id unchanged. A `RequestId` is a ULID the client makes for every command and read. A `Cursor` is `{ stream: "office:<id>" | "software", seq }`.

**Story keys.** The engine gives each story a `StoryKey` when it first sees it. Facts and events refer to the key, and every event that names a story carries both the key and the Backlog.md id of that moment. A command may name a story by either. The id of a story changes only when the engine promotes a draft (M3), which emits `story.renumbered`. A story whose id vanishes from Backlog.md outside the engine is `Removed`, and a new id is a new story; reconcile says so with a notice. The key lives only in the database (0001).

### 3. Frames

```ts
ClientFrame = { kind: "command", requestId, office?, name, args, origin }
            | { kind: "read", requestId, name, args }
            | { kind: "subscribe", requestId, stream, after?: Cursor, filter?: string[] }
            | { kind: "unsubscribe", stream }
ServerFrame = { kind: "reply", reply: { ok: true, requestId, result, changed?, cursor? }
                                    | { ok: false, requestId, error: EngineError } }
            | { kind: "events", events: Event[] }
Event       = { cursor, at, type, causedBy?: RequestId, data }
```

`changed: false` means the command was valid and the state already matched. A client that wants to read its own write waits until its stream passes the reply's cursor. The engine keeps no per-connection state: every office command names its office.

The daemon serves the frames of one connection side by side. Reads run as they arrive, matched by `requestId`; at most 32 reads and subscribes of a connection run at once, and the next waits its turn; commands start in arrival order; only the subscribes and unsubscribes of one stream wait for each other. A command never waits behind an earlier read or subscribe, so a client that needs a command's entries on a stream subscribes and waits for `stream.mark { caughtUp }` before it sends the command.

### 4. Commands

| Group | Commands |
|---|---|
| Office | `office.open`, `office.forget`, `office.init`, `office.rescan`, `office.reloadConfig`, `office.infer`, `office.confirm`, `office.setPrivacy` |
| Work | `work.run`, `work.answer`, `work.steer`, `work.resume`, `work.discard` |
| Story | `story.park`, `story.drop` |
| Gates | `gate.approve`, `gate.reject` |
| Proposals | `proposal.accept`, `proposal.dismiss` |
| Testing | `test.start`, `test.record` |
| Daemon | `daemon.stop`, `daemon.setLogLevel`, `daemon.resumeScheduling` |

Their behaviour is decided where the subject lives: 0020 for park, resume, drop and discard; 0002 for gates and testing; 0013 for scan, infer and confirm; 0010 for init. `commands.describe` lists every command and read with the JSON Schema of its args and result, and marks those a client must confirm first (`confirm`) or ask for a typed id (`irreversible`). A ritual or roster command arrives with its milestone (0003).

### 5. Reads

`engine.hello`, `daemon.status`, `commands.describe`, `office.snapshot`, `office.desk`, `office.digest`, `office.stats`, `office.profile`, `story.detail`, `story.gate`, `story.losses`, `work.outputRange`, `work.preview` (the dry run of `work.run`) and `work.prompt`. Subscriptions are reads too.

### 6. Events

| Stream | Events |
|---|---|
| Software | `office.registered`, `office.forgotten`, `office.summary` (derived), `daemon.state`, `engine.notice`, `stream.mark` (derived) |
| Office | `story.state`, `story.renumbered`, `story.parked`, `story.pr`, `work.assigned`, `work.phase`, `work.progress`, `work.output`, `work.observed`, `usage.updated`, `gate.reached`, `gate.decided`, `question.asked`, `question.closed`, `proposal.filed`, `proposal.closed`, `test.started`, `test.recorded`, `test.ended`, `scan.finished`, `engine.notice`, `stream.mark` (derived) |

Every event about running work carries a `WorkRef` (story, key, run, agent, role, tier, model) and the engine's view of the run, so the overview shows who works on what without another read. The vocabularies these events carry are short and one per meaning (0009): lifecycle, park reason (0001), phase, and one health value with its signals as evidence.

### 7. Facts in, status derived, change log out

- The engine stores facts. Display status, columns and health are derived by engine code and never stored as truth.
- Every fact write appends a change-log entry in the same transaction: stream, a gap-free seq, the delta, and the derived view at that moment. The log is an outbox and is never read back for decisions. An entry that does not render fails its transaction.
- **Debounce before the log.** Worker output flushes per run every 250 ms or 16 KiB, and progress and usage at most once a second per run. State changes, gates, questions and parks are written at once, after the run's pending output, so order stays causal.
- **The software stream** (office list and daemon events) lives in an in-memory ring buffer for the daemon's lifetime.

### 8. Attach and replay

1. A client reads `engine.hello`, then subscribes to the software stream after the hello's cursor.
2. For an office it reads `office.snapshot`, a view and a cursor from one read transaction, then subscribes after that cursor.
3. On reconnect it subscribes after the last cursor it saw. The engine replays the stored entries after it, sends `stream.mark { caughtUp: true }`, then sends live events.
4. A cursor older than the office's retention, or beyond the stream's last seq, gets `stream.resetRequired`. The client drops its view and starts again at step 2. After a daemon restart the software stream always answers this way.
5. When idle, `stream.mark` every 15 s keeps the cursor fresh and shows a dead connection.
6. Delivery is at least once. Clients drop events whose seq they already have.

### 9. Idempotency and target state

- **Commands are target-state.** Parking what is parked, or resuming a story that already runs, replies `changed: false` and changes nothing.
- **Run commands are stored.** For the commands that start or change a run (`work.run`, `work.resume`, `work.answer`, `work.steer`, `story.park`, `work.discard`, `gate.approve`, `gate.reject`, `test.record`), the request id, a hash of the resolved args and the reply are written in the same transaction as the facts. A retry with the same id after a lost reply gets the same reply. The same id with other args fails with `request.reused`. The records go when their run ends.
- **The text the maintainer writes** (notes, answers, steers) is a maintainer-authored fact, kept for the audit trail and as worker input.

### 10. Errors

`EngineError = { code, message, retryable, details? }`, with dotted codes such as `story.unknown`. Codes are part of the contract; messages are not.

The generic codes are `args.invalid`, `office.unknown`, `story.unknown`, `request.reused`, `stream.resetRequired`, `database.unavailable`, `request.timedOut` (a read or subscribe the daemon did not answer within its 90 s deadline) and `internal`. On a read or subscribe, `request.reused` means another read or subscribe with the same id is still running on the connection. Three of them mean the request may succeed later: `engine.recovering` (wait for `running`), `run.hostAlive` (an old worker host still runs) and `git.fetchFailed`.

### 11. One version

- Client and daemon are one binary and speak one contract version.
- `engine.hello` returns the daemon's binary version. A client of another version prints "daemon runs vX, this binary is vY, run `dipo daemon restart`" and offers nothing else.
- So `dipo daemon restart` always works across versions, a few shapes never change: the frame envelope, the `reply` frame with `EngineError`, `engine.hello` with its version, `daemon.status` (`state`, `pid`, `version`) and `daemon.stop`.

## Part 2. The daemon

### 12. One daemon for all offices

There is one daemon process per user. Inside it each office is its own engine instance with an office-scoped database handle, its scheduler and its runs, and no office code reaches another office. Only the shared subscription limits and spend alerts look across offices (0001).

**The daemon and the engine.** The engine is the brain: a library that decides everything (what runs, gates, parks, reviews, merges) and knows nothing of sockets or processes, so it is tested without starting anything. The daemon is the body: the process that holds the lock, serves the socket, keeps time, starts worker hosts and runs the engine instances.

- **One factory.** The daemon reaches the engine through `createEngine`, which takes the daemon's process concerns (clock, log, spawn, the process probe, how worker hosts, test-box forwarders and the model proxy's listener start, its directories, settings and tools, and the facts only the daemon knows: its PID, its socket, the upgrade check and how a stop is requested) and builds everything else from them: the database, git, the code host, the worker port and every service, in one written order. It returns the engine's commands, reads and streams, and runs recovery and the drain. Tests pass fakes for the process concerns instead.
- **The daemon's own process pieces** (the socket server, the lock, signals, the start time probe, the log and the settings file), the system implementations it passes to `createEngine`, and what the daemon's other forms run (the worker host, the box login, the test shell, config migrate) come from the engine's one platform entry, `@dipsaus-orchestrator/engine/platform`, so only the platform module touches Bun (0004).
- **Growth goes into the engine.** New orchestration (schedules, overnight batches, parallel runs, rituals, the conversation layer) is an engine module. The daemon only runs what the engine schedules and carries what it emits.

### 13. Directories

| Purpose | Path |
|---|---|
| State: `dipo.db`, `dipo.pid`, `runtime.json`, `config.yaml` | `~/Library/Application Support/dipo` |
| Logs | `~/Library/Logs/dipo` |
| Runtime: `dipo.sock`, worker host sockets | `$TMPDIR/dipo`, else `/tmp/dipo-<uid>` |

- **The state directory is the anchor.** It comes from the passwd home, never from `$HOME`, `TMPDIR` or launchd's environment, so every starter finds the same lock. `DIPO_HOME` replaces it for tests only, and tests keep it short (0017).
- **The runtime directory** is chosen after the lock is held. It must be a real directory owned by the user with mode `0700`, else dipo uses a fresh `mkdtemp` directory. Its longest socket path must fit 100 bytes.

### 14. Start, stop, status

- `dipo daemon start` backgrounds `dipo daemon --foreground` through a short-lived `/bin/sh` in its own session, so the daemon is no descendant of the client. It removes `BUN_OPTIONS` and `BUN_FEATURE_FLAG_NO_ORPHANS`, then waits up to 5 s for `engine.hello`.
- Client commands start the daemon when it is not running, unless `daemon.autostart` is false. Read-only commands (`dipo gate`, `dipo run --dry-run`, `dipo stats`, `dipo watch`) never start one.
- `daemon.stop` drains. `dipo daemon stop --force` sends SIGTERM to the PID in `dipo.pid` after checking its start time, then SIGKILL after 10 s.
- `dipo daemon status` prints the state with its reason, PID, version, build commit, loaded offices, active runs and keep-awake. Exit 0 means running, 3 not running, 1 unresponsive.
- The daemon does not exit when idle.

### 15. The lock

`dipo.pid` holds the PID, the process start time and the version. On start:

1. If the PID in it is alive, has the same start time and runs `dipo daemon`, a daemon runs. Handshake with it, or report it unresponsive.
2. Otherwise the record is stale. Delete it, unless the file changed since it was read: then another starter won.
3. Create `dipo.pid` with `O_EXCL`. If that fails, another starter won, so go back to step 1 once. Only while it holds the lock does the daemon choose the runtime directory, remove a leftover socket there and bind, and it checks the lock once more right after the bind.

A running daemon checks at its minute upgrade check (section 19) that `dipo.pid` still holds its record. One that lost it drains, exits 1 and leaves the record and the socket path to the daemon that holds them, so two daemons never run on one database. Only a starting daemon deletes `dipo.pid`; a client reports a stale one.

The start time comes from the `kern.proc` sysctls through `bun:ffi` on macOS, because sandboxed processes cannot run `/bin/ps`. On clean exit the daemon removes the socket, then `dipo.pid`.

### 16. States and recovery

```
starting -> recovering -> running -> draining -> (exit)
```

- **starting.** Lock held, directories checked, socket bound. `engine.hello` and `daemon.*` work. Office commands get `engine.recovering`.
- **recovering.** Run migrations (0007), then for each office: reconcile against Backlog.md and git, then re-attach or park each worker host (section 17), then remove the temp directories of ended runs. If the database cannot be opened or migrated, the daemon stays here with the reason. Office requests then get `database.unavailable`, and the reason says what to do.
- **running.** Scheduling on.
- **draining.** Triggered by `daemon.stop`, SIGTERM, SIGINT, a restart or an uncaught error. No new work starts, pending writes finish, and clients are told. Worker hosts keep running unless `stopWorkers` is set. The drain is capped at 20 s, or 60 s with `stopWorkers`.

The daemon keeps no state only in memory, so recovery after a crash is the same as after a clean stop.

### 17. Worker hosts

The daemon never owns a worker process. Each session gets a worker host, `dipo daemon worker-host <run>`, started detached with its stdio to files.

- **What the host does.** It starts the session through the adapter's launch plan (for a developer, a `container exec` into the story's box, 0008). It appends every output line to the run's `events.ndjson` with its byte offset, and listens on `<runtime>/hosts/<run>.sock` for writes to the session's stdin and for signals. When the session exits, it writes `exit.json` and exits. It has no engine logic.
- **Facts and offsets move together.** The engine reads the events file from a stored offset. That offset advances in the same transaction as the facts derived from the lines, so a crash never skips or doubles an event.
- **Liveness** is the PID plus its start time, never socket reachability.
- **Re-attach at recovery,** for each host:
  - Alive, and its socket answers the handshake: catch up from the offset, then follow live.
  - Alive, but its socket does not answer, or it speaks another host protocol version: send its verified PID one SIGTERM, and park the story `worker-failed` once it exits.
  - Dead, with `exit.json`: process the remaining lines and the exit.
  - Dead, without `exit.json`, or no live process matches its record: park the story `worker-failed`.
- **One host at a time.** The engine never starts a new host for a run whose old host is alive (`run.hostAlive`).
- **`--no-orphans` is never active** in the daemon chain. It would kill a detached daemon with its starter, and every host with the daemon. The daemon refuses to start when it is set.

### 18. Transport and security

- **Transport.** Clients connect with WebSocket over the Unix socket: `Bun.serve({ unix })` on the daemon side, `ws+unix://` in `client/node`. Each text frame holds one JSON frame (section 3).
- **Security.** The runtime directory, real, owned by the user and `0700`, is the only guard; the socket file's own mode is not relied on. Any process of the same user can use the socket, which is in scope by design: there is one local user.
- **No network listener.** The daemon opens none. A web or desktop client is Later (0003) and gets its own decision when it is planned.

### 19. Keep-awake, logs, upgrades, autostart

- **Keep-awake.** While any office has a live worker host or a confirmed run waiting to start, the daemon holds `caffeinate -i -w <daemon pid>`, and releases it 2 minutes after work stops. Closing the lid on battery still sleeps the Mac.
- **Logs.** JSON lines with time, level, message, component, office and run, in `daemon.log`, rotated at 10 MB with 5 kept. A worker host writes `host.log` in its run directory. Prompts and command bodies appear only at `debug` and `trace`. A field whose name ends in `token`, `secret`, `password`, `apiKey`, `credential` or `privateKey` is redacted at every level. `dipo daemon logs` reads the files directly, so it works while the daemon is down.
- **Upgrades.** A running daemon keeps its old binary. It checks its executable every 60 s and reports "upgrade pending". `dipo daemon restart` drains it and starts the new binary. Worker hosts keep running, and the new daemon re-attaches them (section 17).
- **Autostart.** `dipo daemon install` writes a launchd agent with `KeepAlive` (restart after a crash), `AbandonProcessGroup` and an exit timeout above the drain cap. With it, `dipo daemon start`, `stop` and `restart` go through `launchctl`. `dipo daemon uninstall` removes it.
- **Software settings** live in `<state>/config.yaml`: `daemon.autostart`, the spend alerts and `notify.desk` (0009).

## Replaced

- Contract major and minor versions, capability flags and provisional commands (2026-10-10). Replaced by one contract version per binary (2026-10-24), because client and daemon ship together.
- A random epoch in every cursor and a replay floor (2026-10-10). Gone with backups and restore (0007, 2026-10-24). A cursor beyond the last seq asks for a reset.
- A 24-hour idempotency table for every command, a waiting path for slow commands, and a crash-injection test per command (2026-10-10, 2026-10-17). Replaced by target-state commands plus stored replies for run commands only (2026-10-24).
- A browser listener on 127.0.0.1 with a bootstrap code, session tokens, an `auth` frame and DNS-rebinding checks (2026-10-10). Never used; removed until a web client is planned (2026-10-24).
- A `confirmed` flag for a conversation layer (2026-10-10). It returns with M5.
- Story identity after a database loss matched by frozen branch, then created date (2026-10-10). Replaced by: a vanished id is Removed, a new id is a new story (2026-10-24).
- `work.pause`, `work.reassign`, `work.stop`, `story.hold`, `office.purge`, `daemon.webBootstrap`, `office.usage` and the `office.switch` alias. Replaced by `story.park` (0020), or removed.
- A crash-loop `safe` state, a held `recovering` state with crash markers and `needsCheck`, and a minute-by-minute lock self-check that recreated a missing record and took a foreign one back (2026-10-10 to 2026-10-16). Replaced by the plain states of section 16 (2026-10-24) and a check that only stops a daemon that lost its lock (section 15, 2026-10-30).
- A PID lock broken by rename-and-verify with a `link()` restore and a stale-break window re-check (2026-10-10). Replaced by the plain lock of section 15 (2026-10-24).
- Follow-only worker hosts, a verified-SIGTERM protocol for them, and a `launch.json` claim and rename protocol for pending hosts (2026-10-15). Replaced by re-attach or park (2026-10-24).
- Linux support: systemd units and scopes, `systemd-inhibit`, lingering checks (2026-10-10). macOS only (0004, 2026-10-24).
- Auto-restart on upgrade (`daemon.autoRestartOnUpgrade`, default off). Removed; `dipo daemon restart` is the way (2026-10-24).
- `createEngine` building its own spawn and clock from the daemon's options (2026-10-24). The daemon passes them in with its other process concerns, so tests replace them (2026-10-29).
