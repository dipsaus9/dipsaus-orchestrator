# 0007 State database

Status: Proposed (spike DIPO-4, 2026-10-10).

## Context

Each office keeps its orchestration state in a local, gitignored database (0001, 0011). Backlog.md owns story facts, git owns code history, and the database owns run detail. 0004 fixed SQLite through `bun:sqlite`, reached only through `engine/src/platform`, and ruled out SQLite extensions. Other accepted decisions hand this ADR concrete duties:

- 0005: fact tables, an office change log with `epoch` and gap-free `seq` written in the same transaction as the facts, the idempotency request table (24 h), StoryKeys with an alias table, tiered retention (state events 1 year, usage and progress and worker output 7 days, run summaries kept as long as state), and derived views computed only in the engine.
- 0006: one daemon serves all offices, each office has its own engine instance and database handle, a per-office lock guards the database, migrations run in the `recovering` state, and each worker host's processed offset advances in the same transaction as the facts derived from its events.
- 0013: one run profile per office, with fingerprint and scan time, stored in the database.
- Drafts still in review: 0010 (lane-b journal, released-branch records, claims), 0014 (worker notes deleted at teardown, prompt hashes and sizes, measurement results), 0017 (config hash per run; `.dipo/` gitignore rules handed here).
- Research ideas 1 (facts stored, status derived), 4 (estimated cost from a versioned pricing catalog), 11 (no prompts or command bodies by default) and 21 (usage tailing resumes from a stored offset).

`bun:sqlite` facts, checked 2026-10-10 against the Bun and SQLite docs and a local test on Bun 1.3.5, macOS arm64:

- `bun:sqlite` is synchronous and supports WAL via `PRAGMA journal_mode = WAL`, which the Bun docs recommend [1]. `db.transaction(fn)` commits on return and rolls back on throw, nests as savepoints, and has `.deferred()`, `.immediate()` and `.exclusive()` variants [1]. `strict: true` makes a missing bound parameter an error [1]. Integers come back as `number` unless `safeIntegers` is on [1].
- On macOS Bun uses the system SQLite; `Database.setCustomSQLite` swaps it [1]. Local test: system SQLite is 3.51.0, `busy_timeout` defaults to 0, `foreign_keys` defaults to off, JSON functions and FTS5 are compiled in, and a second writer with a 200 ms busy timeout got `database is locked` after about 230 ms. On Linux Bun 1.4.2 links SQLite 3.53.2 statically, per a secondary source [7]; the first M0 story confirms it with `select sqlite_version()`.
- WAL allows one writer at a time; readers and the writer do not block each other; every process must be on the same host, never a network filesystem; the `-wal` file is part of the database [2]. WAL mode persists in the file [2].
- SQLite 3.7.0 to 3.51.2 carry a rare WAL-reset bug that needs two or more connections writing or checkpointing at the same instant; 3.51.3 fixes it, with backports in 3.44.6 and 3.50.7 [2]. The macOS system SQLite above is in that range.
- With `synchronous=NORMAL` a WAL commit may roll back after power loss; `FULL` keeps it [3]. `foreign_keys` is per connection and a no-op inside a transaction [3]. `user_version` is free for the application [3].
- `VACUUM INTO` writes a consistent, compact snapshot to a new file without taking the write lock [4]. Local test: it works through `bun:sqlite`.

## Options

**Where an office's state lives.**

| | A. `<repo>/.dipo/state/`, gitignored | B. `<state>/offices/<OfficeId>/` in the software anchor (0006) | C. `<git-common-dir>/dipo/` |
|---|---|---|---|
| Moves with the repository | yes | no; needs a marker in the repo anyway (0006 decision 4) | yes |
| Needs a gitignore entry | yes (0010 forbids editing `.gitignore`) | no | no, git never tracks `.git/` |
| Survives `git clean -fdx` | no, it is deleted | yes | yes |
| Shared by all worktrees of the repo | no (worktrees are separate checkouts) | yes | yes, `--git-common-dir` is the same from every worktree |
| Deleted with the repository | yes | no, leaves orphans | yes |
| Isolation between offices | by path | one parent directory for all offices | by path |
| `cp -r` of the repository | copies the `OfficeId` | no effect | copies the `OfficeId` |
| Repository in iCloud Drive or Dropbox | syncs a live WAL database | no effect | syncs a live WAL database |
| Surprise in `du`, Docker build contexts | yes | no | backups inside `.git` inflate `.git` size |

C writes only inside `.git/`, which is not the working tree, so it does not break 0010's rule that the engine never writes the maintainer's main checkout. The C downsides are handled in section 2: backups go to the anchor, a copied `OfficeId` is detected, and a synced folder gets a warning.

**Writers.** One connection per office in the daemon, or a connection per request, or worker hosts writing directly. Worker hosts have no engine logic (0006) and write files; several connections would bring back the WAL-reset bug on macOS and `SQLITE_BUSY` handling. One connection, used from the daemon's single JS thread, needs no locking inside the process.

**Worker output.** In files next to the raw event stream, or in a table. A table lets output chunks, their change-log entries and the processed offset commit together, and lets retention delete them by date.

## Decision

### 1. One SQLite file per office, one writer

- **Engine:** `bun:sqlite` behind `engine/src/platform`, opened with `{ create: true, readwrite: true, strict: true }`. No extensions, so the macOS system SQLite is fine.
- **One connection per office**, held by that office's engine instance in the daemon. All writes run as `db.transaction(fn).immediate()`. Reads that must match a cursor (0005 `office.snapshot`) run inside one deferred transaction. Nothing else writes the file: not worker hosts, not the CLI, not tests against a live office. A maintainer may open it read-only with `sqlite3 -readonly` for debugging.
- **Pragmas at open**, every time: `journal_mode=WAL`, `synchronous=FULL` (state facts sit next to git and Backlog.md side effects, so a commit that vanishes on power loss would create a mismatch; write volume is small), `foreign_keys=ON`, `busy_timeout=5000` (the daemon never competes with itself; the timeout makes a TRUNCATE checkpoint or WAL recovery wait for an external read-only connection, or the backup Worker of section 10, instead of failing at once), `journal_size_limit=67108864`, default `wal_autocheckpoint` (1000 pages). A new file also gets `auto_vacuum=INCREMENTAL` before its first table.
- Tables are `STRICT`. Ids are `TEXT`. Times are `INTEGER` milliseconds since epoch, UTC. Money is `INTEGER` micro-USD. Token counts, byte offsets and `seq` stay well under 2^53, so `safeIntegers` stays off.
- At load the engine logs `sqlite_version()` and refuses a WAL database on a network filesystem (`statfs` type check in the platform module) with a clear error. A path under iCloud Drive, Dropbox or a similar sync folder gets a warning, because a sync client copying `state.db` without its `-wal` file can restore a broken set.
- **Pauses on the daemon thread.** The daemon has one JS thread, so long SQLite calls block every office. Maintenance runs in slices with a budget of 50 ms per call: incremental vacuum in steps of a few hundred pages, `wal_checkpoint(PASSIVE)` routinely and `TRUNCATE` only when idle. `VACUUM INTO` (backups, pre-migration copies) runs in a Bun Worker with its own read-only connection, which takes no write lock [4]. M0 measures the pause of a commit with `synchronous=FULL` and of each maintenance step and adjusts the budget.

### 2. Layout on disk

The office path is always the main worktree: the first entry of `git worktree list --porcelain`. `office open` from a linked worktree resolves to that main worktree through the common directory and opens the same office; it is not treated as a moved repository. The office state directory is `<git-common-dir>/dipo/`, resolved with `git rev-parse --path-format=absolute --git-common-dir`. For a normal clone that is `<repo>/.git/dipo/`.

```
<repo>/.git/dipo/                  # office state, never tracked, mode 0700
  office.json                      # { officeId, createdAt } marker, written by office init
  office.lock                      # per-office lock (section 3)
  state.db, state.db-wal, state.db-shm
  runs/<run-id>/
    events.ndjson                  # raw worker stream written by the worker host (0006)
    exit.json                      # written by the host at worker exit
    host.log                       # host diagnostics, capped at 5 MB (0006)
<state>/offices/<OfficeId>/backups/ # software anchor (0006), outside the repository
  state-<yyyymmdd>.db              # daily VACUUM INTO snapshots
  pre-v<N>-<yyyymmddThhmmss>.db    # before each migration
<repo>/.dipo/                      # committed office configuration (0017)
  office.yaml, roles/
  .gitignore                       # one line: office.local.yaml
  office.local.yaml                # machine-local, ignored
```

Backups sit in the anchor so they do not inflate `.git`, do not end up in Docker build contexts, and survive deleting the repository. `office.forget` keeps them; `office purge` deletes them too.

Outside the repository, unchanged from 0006: the office list, PID lock, crash counter and port slot table in `<state>`; the daemon log in `<logs>` (lines carry `office` and `run` fields); all sockets, including `hosts/<run-id>.sock`, in the runtime directory. 0010 keeps worktrees under `../<repo>.worktrees/`.

What is gitignored: nothing extra is needed for the state, because git never tracks `.git/`. The only ignore rule is `.dipo/.gitignore` with `office.local.yaml`. Office init adds it, only if absent, as a commit in the office-init backlog PR (0010 lane b), and `office uninstall` removes it the same way. The engine never writes it into the maintainer's main checkout. This satisfies 0017 (no runtime file under `.dipo/`, local overrides always ignored) and leaves the root `.gitignore` and `info/exclude` untouched as 0010 requires.

The `office.json` marker carries the `OfficeId` that 0006 matches to detect a moved repository. A fresh clone has no marker and is a new office. A copy made with `cp -r` carries the same marker: when `office open` finds an `OfficeId` already registered and the registered path still exists with that same id, the copy gets a new `OfficeId`, a new `office.json` and a fresh database, with a notice. Only when the old path is gone is it a move. `office.forget` keeps the directory; `dipo office purge` (name per DIPO-2, confirm required) deletes it.

### 3. Per-office lock

Same mechanism as 0006 decision 6, one level down. Before opening `state.db` the engine creates `office.lock` with `O_CREAT | O_EXCL` holding PID, process start time, daemon version and hostname. A live holder with the same start time means another daemon owns the office: refuse to load it and emit `engine.notice`. A stale record is broken by rename-and-verify, at most 3 tries. Every minute the instance checks the record still holds its own PID and start time; if not, it stops writing, unloads the office and logs an error. On unload the instance closes the database (`close(true)`) and then removes the lock. A different hostname in the record (a repository on a shared disk) is never treated as stale; the maintainer must remove it by hand.

### 4. Schema outline

Names are indicative; M0 stories write the DDL. "Kept" names the retention tier from section 7: **S** state (1 year), **R** short (7 days), **T** until worktree teardown, **D** 24 hours, **P** permanent until purge.

The database stores facts: things that happened, with time and cause. It stores no display status, column, health or budget share. The engine derives those when it reads and puts the derived view into change-log entries and snapshots (0005 section 6, research idea 1). The `backlog_mirror` table is a cache of what reconcile last read from Backlog.md, never a source of truth.

| Group | Table | Holds | Kept |
|---|---|---|---|
| Meta | `meta` | `office_id`, `epoch`, `next_seq`, `replay_floor_seq`, created time | P |
| | `schema_migrations` | version, name, checksum, engine version, applied time. `PRAGMA user_version` mirrors the head | P |
| Identity | `stories` | `key` (`sto_<ulid>`), current `story_id`, `provisional`, frozen branch, Backlog created date, first seen, removed time | P |
| | `story_aliases` | `key`, former id, valid from, retired at (0005 section 2) | P |
| | `backlog_mirror` | per key: content hash, status, tier, role, labels, read time, source (`base`, story branch) | P, overwritten |
| Change log | `change_log` | `seq` (primary key), time, `type`, `tier` (`S` or `R`), `key`, `run_id`, `caused_by` request id, `delta` JSON, `view` JSON | by tier |
| Requests | `requests` | `request_id`, command name, args hash (after resolving StoryKeys), reply JSON, time | D |
| Runs | `runs` | `run_id`, `key`, story id at start, tier, role, model, start SHA, branch, worktree, slot, budget unit and limit, loop cap, review round cap (snapshot at start), `config_hash`, active local override keys, `run_profile_id`, start and end time, end kind | S |
| | `agents` | `agent_id`, `run_id`, role, model, effort, native session id, system prompt hash (0014 L1+L2), Claude Code version, start, end, end reason | S |
| | `run_steps` | append-only: phase entered, loop started, review round started, with time | S |
| | `run_summaries` | final worker report, diffstat, verify result, last 50 output lines, built at run end without a model (0005) | S |
| Process | `worker_hosts` | `run_id`, `agent_id`, PID, start time, socket path, host protocol version, event file, `processed_offset`, exit code, signal, final offset, mode (`steer` or `follow`) | S |
| | `ingest_cursors` | source kind (`host-events`, `transcript`), path, file identity (device, inode, size at last read), `offset`, last line hash, agent | R after run end |
| | `usage_high_water` | per agent: newest message id and time counted, messages counted; dedupe guard that outlives `usage_messages` | S |
| Usage | `usage_messages` | `agent_id`, message id (unique pair), model, input, output, cache write 5 m and 1 h, cache read, time | R |
| | `usage_totals` | per run and agent: role, tier, model, the same token fields, turns, elapsed ms, budget unit and used, `est_cost_micros`, `pricing_version`, `final` flag. Updated in the same transaction as each `usage_messages` insert; `final` set at run end | S |
| | `usage_daily` | rollup per day, role, tier, model: tokens, turns, runs, estimated cost, budget used, budget limit sum. Fed only from `usage_totals` rows when they become `final` | P |
| | `pricing_catalogs`, `pricing_rates` | catalog version, source, effective date, checksum; rate per model per million tokens for input, output, cache write 5 m, cache write 1 h, cache read, in micro-USD | P |
| Review and gates | `gates` | `gate_id`, kind (`ready`, `pickup`, `review`, `test`, `merge`, `backlog-pr`), `key`, `run_id`, opened, waiting on, summary | S |
| | `gate_decisions` | `gate_id`, decision, by (`maintainer` or `rule`), note, rule results (0012 R-numbers), story content hash the decision applies to (0010 structural check), time | S |
| | `review_verdicts` | `run_id`, round, reviewer agent, commit SHA, code tree key (0010), pass or blocked, per-criterion result, full findings | S |
| Parks | `parks` | park id, `key`, `run_id`, reason (0005 `ParkReason`), from lifecycle, detail, last good commit, time; resolved time and how (`resume`, `amend`, `drop`, `discard`, `reconcile`). Park history and detail; the current park state is the Backlog.md F16 story fact (0001, 0012) | S |
| Questions | `questions` | `question_id`, run, agent, text, asked, answer, answered, delivered when | S |
| Tests | `verify_results` | `run_id`, loop, code tree key, commands, exit code, duration, timed out, output chunk range | S (output R) |
| | `acceptance_tests` | `test_id`, `key`, run, checkout path, started, pass or fail, note, recorded | S |
| Output | `output_chunks` | `run_id`, source (`worker`, `verify`, `script`), byte range, text (privacy rules in section 8) | R |
| Run profile | `scans` | scan id, trigger (`start`, `run`, `test`, `rescan`), started, finished, fingerprint, commit, result, diff from previous | S |
| | `run_profiles` | profile id, scanned at, commit, fingerprint, toolchain JSON, conformance level, deviations, `previous_profile_id`, current flag | P (current and previous) |
| | `run_capabilities` | profile, capability, command list, working dir, source, confidence, confirmed, pending, stale | P |
| | `run_env_files`, `run_ports`, `run_extra_scripts` | 0013 section 4, paths and names only | P |
| Git and backlog | `claims` | `key`, branch, worktree, run, start SHA, claimed, released, release reason | S |
| | `released_branches` | `key`, branch, released at, reason, reclaimed at (0010 section 2a) | until reclaimed or deleted |
| | `backlog_journal` | op id, `key`, op kind, target state JSON, engine branch, state (`pending`, `applied`, `committed`, `pushed`, `merged`, `dropped`, `withdrawn`), PR ref, notice, times | open ones P, closed ones S |
| | `backlog_config_previous` | Backlog.md settings office init changed, for uninstall (0010) | P |
| Prompts | `prompt_parts` | run, agent, part name, sha256, bytes, estimated tokens, nudge count (0014) | S |
| | `worker_notes` | `key`, run, agent, role, text up to 1,500 characters (0014) | T |
| | `context_packs` | worktree, head SHA, blob ids of scope and input files, built at (0014) | T |
| | `measure_rounds`, `measure_runs` | 0014 measurement: arm, story, repetition, metrics, outcome | P until the maintainer deletes a round |
| Config | `config_snapshots` | config hash, effective configuration JSON (from `office.yaml`, no secrets), first seen | S after last referencing run |

How the schema answers the open requirements:

- **Usage per story, role and tier against budget.** `usage_totals` joins `runs` (tier, role, budget) and `stories` (key) per run and agent, so a reassign keeps usage attributable. `usage_daily` gives trends after run detail ages out. Budget unit and limit are copied into `runs` at start, so a later change to `office.yaml` does not rewrite history.
- **Tokens plus estimated cost.** The binary ships pricing catalogs as versioned files (`pricing/v<N>.json`); the engine imports any version it lacks at load and never edits an imported version. Each usage row stores tokens and `est_cost_micros` with the `pricing_version` used, so a new catalog can re-price history without losing the old number. Cost is an API-equivalent estimate shown next to plan-limit use, not a bill.
- **Change log feeds the stream.** Each fact write appends one `change_log` row in the same transaction and bumps `meta.next_seq`. A rolled-back transaction consumes no seq, so seq is gap-free while written. `epoch` is random per database, stored only in `meta`, and replaced on restore (section 10).
- **Processed offsets.** `worker_hosts.processed_offset` and `ingest_cursors.offset` advance in the same transaction as the facts parsed from those bytes (0006 decision 8).
- **Config hash.** `runs.config_hash` is sha256 over the canonical JSON of the effective configuration; `config_snapshots` keeps the content once per hash (0017).

### 5. Usage ingestion resumes from a stored offset (research idea 21)

The worker host appends the worker's stream to `events.ndjson`; the engine reads complete lines from `processed_offset` on, parses them, writes facts, usage rows and the new offset in one transaction. The same applies to any transcript file the adapter tails (DIPO-5 decides whether it needs one). After a restart the engine resumes at the stored offset. A partial last line waits for the next read.

When a file's identity changed or its size is below the stored offset:

- **Transcript source** (written by Claude Code, which may rotate or rewrite it): read from 0. The unique `(agent_id, message_id)` key on `usage_messages` drops what was already counted. After those rows age out, `usage_high_water` skips any message at or before the agent's newest counted one, so tokens are never counted twice.
- **Host event file** (written only by our worker host, append-only): never replayed. A run that is still active parks `interrupted` with the detail "event file changed"; an ended run gets an `engine.notice`. Facts already stored stay.

### 6. Startup reconcile

Runs in the daemon's `recovering` state for each office it loads, after migrations and worker-host re-attach (0006 decisions 7 and 8), and again on `office.rescan`. Scheduling stays off until it finishes.

1. Take the office lock, open the database, check `office.json` and `meta.office_id` agree; a mismatch refuses the office with a notice.
2. Replay unfinished lane-b releases from `backlog_journal`, then rebuild the backlog branch as 0010 section 2 describes.
3. Read every task and draft through the Backlog CLI on the base and, for claimed stories, on the story branch. Match identity by field-block `key`, then frozen branch, then created date (0005, 0010). Update `stories` and `story_aliases`; emit `story.renumbered` or close keys as `Removed`.
4. Read git: `git worktree list --porcelain`, local refs of claimed and released branches, and the recorded SHAs. Fetch only if the remote answers; offline reconcile uses local refs.
5. Compute the run profile fingerprint (0013 section 5).
6. Apply the table below. Each mismatch writes facts and an `engine.notice` in one transaction; nothing changes silently (0001).

| Field | Wins | On mismatch |
|---|---|---|
| Title, outcome, criteria, dependencies, scope, inputs, tier, role, test plan, unknowns, test-before-merge flag, priority | Backlog.md | Update `backlog_mirror`; a changed field on a running story is reported to the maintainer, the run continues |
| Story id and identity | Backlog.md (field-block `key` first) | Alias or `Removed` per 0005; a live run on a removed story is stopped |
| Lifecycle status | Backlog.md: story branch while claimed, base otherwise | DB run active but status no longer In Progress or In Review: stop the run, notice. Status In Progress with no claim in the DB: notice, story shown as unknown run, never auto-started |
| Park history and detail (earlier parks, last good commit, run) | DB `parks` | Not compared |
| Current park state (parked or not, reason) | Backlog.md F16, a story fact | DB open park with no F16 in Backlog: close it with `resolved_how = reconcile`; F16 with no DB park: record a park from Backlog with detail "recorded by hand" |
| Ready | Backlog.md status | Ready with no `gate_decisions` row for the current content hash: notice; pickup re-check (R01b) decides |
| Branch existence, worktree path, HEAD SHA | git | Update `claims`; a running story whose worktree or branch changed by hand parks (0010) |
| Merged and Done | git and the host's PR state | Close the claim and run |
| Pending lane-b operation | DB journal | Re-applied as target state (0010); one that no longer applies is dropped with a notice |
| Run detail: runs, agents, steps, loops, usage, verdicts, gates, tests, questions, summaries, notes | DB | Not compared; Backlog and git hold none of it |
| Worker process liveness | the OS: PID with start time, exit file | 0006 decision 8 rules |
| Run profile capabilities from code | repository files (fingerprint) | Rescan automatically, store diff |
| Maintainer-confirmed or AI-inferred capabilities | DB | Marked stale, listed for the maintainer (0013) |
| Configuration | `.dipo/office.yaml` | DB keeps hashes only; nothing to reconcile |

### 7. Retention jobs

Each office instance runs retention at load and then hourly, in batches of at most 5,000 rows per transaction so the write lock stays short. Periods are office configuration (`retention.*`, 0017 shell).

| Tier | Default | Deletes |
|---|---|---|
| D | 24 h | `requests` |
| R (short) | 7 days | `change_log` rows with tier R (`work.output`, `work.progress`, `usage.updated`, `work.observed`), `output_chunks`, `usage_messages`, `ingest_cursors` of ended runs, opt-in prompt bodies |
| T | at worktree teardown | `worker_notes`, `context_packs` for that worktree |
| S (state) | 1 year | `change_log` rows with tier S and every S table row whose run or story ended before the cutoff |
| P | never by age | Meta, identity, `usage_daily`, pricing, current and previous run profile, open journal entries |

- `usage_daily` has one source: each `usage_totals` row when it becomes `final`. Deleting `usage_messages` changes no total, so trends survive both tiers.
- `meta.replay_floor_seq` moves to the lowest seq after which no R-tier row was deleted. A `subscribe` below it, or with another epoch, gets `stream.resetRequired` (0005 section 8). Older S-tier rows stay for `story.detail` and audit, not for replay.
- Run directories: `events.ndjson` is deleted once the run has ended, `processed_offset` equals the exit file's final offset and the run summary exists. Fallback: tier R after run end it is deleted in every case, with an `engine.notice` if it was never fully processed. `host.log` and `exit.json` follow after tier R. With the opt-in `privacy.keepRawEvents` the raw stream is kept for tier R too.
- Daily, when the office is idle: `PRAGMA incremental_vacuum(N)` in slices, `PRAGMA wal_checkpoint(TRUNCATE)`, `PRAGMA optimize`, each within the time budget of section 1. Retention batches stay within it too.

### 8. Privacy (research idea 11)

By default the database and run directory hold no assembled prompts, no transcripts and no command bodies.

- Prompts: sha256, size and estimated tokens per part only (0014). The idempotency record holds an args hash (0005).
- Worker output stored in `output_chunks` is assistant text plus one line per tool call with the tool name and target path. Shell command text, tool inputs and tool results from the worker stream are not stored. Output of scripts the engine runs itself (verify, setup, `dev`) is stored in full for tier R; it is the repository's own output.
- The raw `events.ndjson` does contain tool inputs. It exists only while the run needs it (section 7) and lives in a `0700` directory.
- Env files: names and paths only, never contents or hashes (0013).
- Kept on purpose: text the maintainer writes (steer, answer, reject, hold, test notes), worker questions, the worker's final report, worker notes until teardown, and reviewer findings in full (0001).
- Opt-ins, off by default: `privacy.storePrompts` (assembled prompts, tier R), `privacy.storeCommandBodies` (tool inputs in `output_chunks`), `privacy.keepRawEvents`. Each one is machine-local, so they belong in `.dipo/office.local.yaml` (open question 3). The overview shows when one is on.

### 9. Migrations

- Forward-only, numbered migrations compiled into the binary, each a SQL or TypeScript step with a checksum. `PRAGMA user_version` holds the head; `schema_migrations` records each step.
- They run per office in `recovering` (0006), before reconcile. First a `VACUUM INTO <state>/offices/<OfficeId>/backups/pre-v<N>-<time>.db` (scheduling is off, so the pause is acceptable). Then each step in its own immediate transaction. Table changes SQLite cannot `ALTER` use the documented rebuild (new table, copy, drop, rename) with `foreign_keys` switched off outside the transaction and `PRAGMA foreign_key_check` before commit.
- A failed step rolls back; the office stays unloaded with a notice naming the backup; other offices load normally.
- A database newer than the binary is refused with "upgrade dipo", as 0017 does for config files. Downgrade means restoring the pre-migration backup.
- A recorded checksum that differs from the binary's step stops the load: someone edited a released migration.
- The change log needs no data migration: events are rendered at send time (0005).
- Tests: a fresh database built from all steps must equal one migrated from a fixture of each released schema version, compared by `sqlite_schema` dump. Before 1.0 the steps may be squashed once, with fixtures regenerated.

### 10. Backups

- Daily, when the office is idle or at least every 24 h, `VACUUM INTO <state>/offices/<OfficeId>/backups/state-<yyyymmdd>.db` from a Bun Worker with a read-only connection (section 1), then `PRAGMA quick_check` on the copy in that Worker. Keep 3 daily and the 2 newest pre-migration copies.
- A plain file copy of `state.db` is not a backup while the daemon runs, because recent commits may sit only in the `-wal` file [2]. Time Machine and similar tools may catch an inconsistent set; the daily snapshot is the copy to restore.
- Restore is a command (`dipo office restore <file>`, name per DIPO-2) that unloads the office, copies the file into place, writes a new `epoch` into `meta` (`office.json` holds no epoch, so it needs no rewrite), and then runs reconcile. Clients get `stream.resetRequired`.
- Losing every copy loses run history, never the project (0001): a new database is created, reconcile rebuilds identity from Backlog.md field-block keys and a rescan rebuilds the code part of the run profile.

### 11. Size estimates

Assumptions to replace with measurements from the first M0 runs: a run lasts about 45 minutes, about 1,500 progress and usage log entries at 600 bytes each, 300 KB of stored worker output, 3 verify loops of 50 KB output, 200 assistant messages; state rows (about 50 state events, verdicts, summary, totals) about 80 KB per run. Indexes add about 30 percent. On top come up to 64 MB of `-wal` file (`journal_size_limit`) and free pages incremental vacuum has not yet returned, roughly 10 percent of the file.

| Office load | Short tier, steady (7 days) | State tier after 1 year | Database | Backups (3 + 2), in `<state>` |
|---|---|---|---|---|
| 3 runs a day | about 30 MB | about 90 MB | about 150 MB, plus up to 64 MB WAL | about 750 MB |
| 10 runs a day | about 100 MB | about 300 MB | about 500 MB, plus up to 64 MB WAL | about 2.5 GB |

A running worker's `events.ndjson` with partial messages can reach tens of MB and is deleted at run end. `dipo office stats` (name per DIPO-2) shows table sizes so the retention defaults can be tuned.

## Consequences

- State lives with the repository but outside every working tree, so worktrees, `git clean` and the committed `.dipo/` never touch it, and no root `.gitignore` edit is needed.
- One writer per office makes ordering trivial and avoids `SQLITE_BUSY` inside the daemon. The cost: no other process may write the database, so any future out-of-process tool goes through commands.
- `synchronous=FULL` costs an fsync per commit; with output batched every 250 ms and usage once per second per run (0005) this stays small. M0 measures it.
- The macOS system SQLite 3.51.0 is in the WAL-reset bug range; the single connection avoids the trigger. If a second writer is ever added, ship a fixed SQLite via `setCustomSQLite` first.
- Backups live in the anchor, so `.git` stays small and backups outlive the repository. On busy offices they take gigabytes; the keep counts are configuration.
- A Bun Worker for `VACUUM INTO` is one more Bun touchpoint inside the platform module.
- M0 stories: platform database module with pragmas and lock; schema and migrations runner with fixtures; change log and request table; ingestion with offsets; reconcile; retention and backup jobs; pricing catalog import. M1 adds verdicts, gates beyond Ready, and spend alerts on `usage_daily`.

## Open questions for the maintainer

1. **Location.** Live state in `<repo>/.git/dipo/` and backups in `<state>/offices/<OfficeId>/backups/` (chosen), or everything in the anchor? The anchor keeps live state when a repository is deleted, which this ADR treats as a downside.
2. **Durability.** `synchronous=FULL` (chosen), or `NORMAL` for fewer fsyncs at the risk of losing the last commits on power loss?
3. **Privacy opt-ins in `office.local.yaml`.** 0017 allowlists only `timeouts.*`. Add `privacy.*` and `retention.*` to that allowlist, or keep them in the committed `office.yaml`?
4. **`.dipo/.gitignore`.** 0017 needs `office.local.yaml` ignored; 0010 says no `.gitignore` edits. A new `.dipo/.gitignore`, committed through the office-init backlog PR (chosen), adds a file rather than editing one. Accept, and amend 0010 section 11 wording?
5. **Long-term usage.** `usage_daily` is kept forever (a few KB a year). Fine, or give it a period?
6. **Backup count.** 3 daily plus 2 pre-migration copies. Enough, or fewer on large offices?
7. **Raw worker stream.** Delete `events.ndjson` at run end by default (chosen), or keep it 7 days for debugging?

## Sources

1. Bun docs, SQLite (WAL recommendation, transactions and their modes, `strict`, `safeIntegers`, `setCustomSQLite`, `serialize`, `fileControl`, macOS WAL sidecar files). https://bun.com/docs/runtime/sqlite
2. SQLite, Write-Ahead Logging (one writer, same host, `-wal` part of the database, persistent mode, checkpoint at 1000 pages, WAL-reset bug fixed in 3.51.3, backported to 3.44.6 and 3.50.7). https://sqlite.org/wal.html
3. SQLite, PRAGMA statements (`busy_timeout`, `synchronous` in WAL, `foreign_keys`, `user_version`, `journal_size_limit`, `auto_vacuum`, `optimize`, `quick_check`). https://sqlite.org/pragma.html
4. SQLite, VACUUM (`VACUUM INTO` is a consistent snapshot and not a write; compared with the backup API). https://sqlite.org/lang_vacuum.html
5. SQLite, ALTER TABLE (rebuild procedure for unsupported changes). https://sqlite.org/lang_altertable.html
6. Local test, Bun 1.3.5 on macOS arm64, 2026-10-10: system SQLite 3.51.0; `busy_timeout` 0 and `foreign_keys` 0 by default; second `BEGIN IMMEDIATE` fails with `database is locked` after the busy timeout; `VACUUM INTO` and `serialize` work; JSON and FTS5 available.
7. OpenClaw docs, Bun compatibility (Linux Bun 1.4.2 statically links SQLite 3.53.2; macOS uses the system SQLite). Secondary source, to confirm in M0. https://docs2.openclaw.ai/install/bun-compatibility.md
8. ADRs 0001, 0004, 0005, 0006, 0011, 0012, 0013, 0017 (draft), 0010 (draft), 0014 (draft); research ideas 1, 4, 11, 21 in `docs/research/2026-10-comparable-tools.md`.
