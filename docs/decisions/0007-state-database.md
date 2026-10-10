# 0007 State database

Status: Accepted (spike DIPO-4, maintainer approval 2026-10-10). Amends 0001, 0005, 0006, 0010 and 0011 (see "Amends").

## Context

Each office keeps its orchestration state locally, never in the repository's tracked files (0001, 0011). Backlog.md owns story facts, git owns code history, and the database owns run detail. 0004 fixed SQLite through `bun:sqlite`, reached only through `engine/src/platform`, and ruled out SQLite extensions. Other accepted decisions hand this ADR concrete duties:

- 0005: fact tables, an office change log with `epoch` and gap-free `seq` written in the same transaction as the facts, the idempotency request table (24 h), StoryKeys with an alias table, tiered retention (state events 1 year, usage and progress and worker output 7 days, run summaries kept as long as state), and derived views computed only in the engine.
- 0006: one daemon serves all offices, each office has its own engine instance, the daemon's PID lock in `<state>` keeps out a second daemon, migrations run in the `recovering` state, and each worker host's processed offset advances in the same transaction as the facts derived from its events. 0006 also planned a per-office database handle and lock and an `offices.json` office list; this ADR replaces those (see "Amends").
- 0013: one run profile per office, with fingerprint and scan time, stored in the database.
- 0010 (accepted): lane-b journal, released-branch records, claims. Drafts still in review: 0014 (worker notes deleted at teardown, prompt hashes and sizes, measurement results), 0017 (config hash per run; `.dipo/` gitignore rules handed here).
- Research ideas 1 (facts stored, status derived), 4 (estimated cost from a versioned pricing catalog), 11 (no prompts or command bodies by default) and 21 (usage tailing resumes from a stored offset).

`bun:sqlite` facts, checked 2026-10-10 against the Bun and SQLite docs and a local test on Bun 1.3.5, macOS arm64:

- `bun:sqlite` is synchronous and supports WAL via `PRAGMA journal_mode = WAL`, which the Bun docs recommend [1]. `db.transaction(fn)` commits on return and rolls back on throw, nests as savepoints, and has `.deferred()`, `.immediate()` and `.exclusive()` variants [1]. `strict: true` makes a missing bound parameter an error [1]. Integers come back as `number` unless `safeIntegers` is on [1].
- On macOS Bun uses the system SQLite; `Database.setCustomSQLite` swaps it [1]. Local test: system SQLite is 3.51.0, `busy_timeout` defaults to 0, `foreign_keys` defaults to off, JSON functions and FTS5 are compiled in, and a second writer with a 200 ms busy timeout got `database is locked` after about 230 ms. On Linux Bun 1.4.2 links SQLite 3.53.2 statically, per a secondary source [7]; the first M0 story confirms it with `select sqlite_version()`.
- WAL allows one writer at a time; readers and the writer do not block each other; every process must be on the same host, never a network filesystem; the `-wal` file is part of the database [2]. WAL mode persists in the file [2].
- SQLite 3.7.0 to 3.51.2 carry a rare WAL-reset bug that needs two or more connections writing or checkpointing at the same instant; 3.51.3 fixes it, with backports in 3.44.6 and 3.50.7 [2]. The macOS system SQLite above is in that range.
- With `synchronous=NORMAL` a WAL commit may roll back after power loss; `FULL` keeps it [3]. `foreign_keys` is per connection and a no-op inside a transaction [3]. `user_version` is free for the application [3].
- `VACUUM INTO` writes a consistent, compact snapshot to a new file without taking the write lock [4]. Local test: it works through `bun:sqlite`.

## Options

**One database per office, or one for the software.**

| | A. One file per office | B. One central file, every office row keyed by `office_id` (chosen) |
|---|---|---|
| Writers | One connection per office, all in the one daemon process anyway | One connection |
| Locks | A per-office lock on top of the daemon's PID lock | The daemon's PID lock only |
| Migrations, backups | Per office, N files to migrate and snapshot | Once for one file |
| Cross-office queries (total usage against the shared Max plan limits, 0001) | Open and join N files | One query |
| Damage from a corrupt file | One office | Every office; mitigated by daily backups |
| Office isolation (0011) | By file | By key: every office-scoped table has `office_id` in its primary key |
| Splitting later | n/a | Mechanical: copy rows per `office_id` |

The maintainer chose B on 2026-10-10: there is one writer process anyway, the maintainer usually works on one or a few projects at a time, M0 gets one file, one migration path, one backup job and one lock, and usage across offices can be compared against the shared subscription limits in one query.

**Where an office's remaining files live** (the `OfficeId` marker and the run directories with raw worker files).

| | A. `<repo>/.dipo/`, gitignored | B. `<state>/offices/<OfficeId>/` in the software anchor (0006) | C. `<git-common-dir>/dipo/` (chosen) |
|---|---|---|---|
| Moves with the repository | yes | no; needs a marker in the repo anyway (0006 decision 4) | yes |
| Needs a gitignore entry | yes (0010 forbids editing `.gitignore`) | no | no, git never tracks `.git/` |
| Survives `git clean -fdx` | no, it is deleted | yes | yes |
| Shared by all worktrees of the repo | no (worktrees are separate checkouts) | yes | yes, `--git-common-dir` is the same from every worktree |
| Deleted with the repository | yes | no, leaves orphans | yes |
| `cp -r` of the repository | copies the `OfficeId` | no effect | copies the `OfficeId` |
| Surprise in `du`, Docker build contexts | yes | no | small: raw run files only, deleted at run end |

C writes only inside `.git/`, which is not the working tree, so it does not break 0010's rule that the engine never writes the maintainer's main checkout. A copied `OfficeId` is detected (section 2).

**Writers.** One connection in the daemon, or a connection per request, or worker hosts writing directly. Worker hosts have no engine logic (0006) and write files; several connections would bring back the WAL-reset bug on macOS and `SQLITE_BUSY` handling. One connection, used from the daemon's single JS thread, needs no locking inside the process.

**Worker output.** In files next to the raw event stream, or in a table. A table lets output chunks, their change-log entries and the processed offset commit together, and lets retention delete them by date.

## Decision

### 1. One SQLite file for the software, one writer

- **Engine:** `bun:sqlite` behind `engine/src/platform`, opened with `{ create: true, readwrite: true, strict: true }`. No extensions, so the macOS system SQLite is fine.
- **File:** `<state>/dipo.db` with its `dipo.db-wal` and `dipo.db-shm` sidecars, in 0006's software state directory (`~/.local/state/dipo` on Linux, `~/Library/Application Support/dipo` on macOS). `<state>` is `0700`, the database files `0600`.
- **One connection**, opened by the daemon after it holds its PID lock and has re-read `dipo.pid` after binding (0006 decision 6), and closed (`close(true)`) when the daemon exits. Each office's engine instance gets an office-scoped handle on that connection: every statement it runs binds that office's `office_id`, and it has no way to name another office. All writes run as `db.transaction(fn).immediate()`. Reads that must match a cursor (0005 `office.snapshot`) run inside one deferred transaction. Calls are synchronous on one JS thread, so transactions of different offices never interleave. Nothing else writes the file: not worker hosts, not the CLI, not tests against a live daemon. A maintainer may open it read-only with `sqlite3 -readonly` for debugging.
- **Pragmas at open**: `journal_mode=WAL`, `synchronous=FULL` (state facts sit next to git and Backlog.md side effects, so a commit that vanishes on power loss would create a mismatch; write volume is small), `foreign_keys=ON`, `busy_timeout=5000` (the daemon never competes with itself; the timeout makes a TRUNCATE checkpoint or WAL recovery wait for an external read-only connection, or the backup Worker of section 10, instead of failing at once), `journal_size_limit=67108864`, default `wal_autocheckpoint` (1000 pages). A new file also gets `auto_vacuum=INCREMENTAL` before its first table.
- Tables are `STRICT`. Ids are `TEXT`. Times are `INTEGER` milliseconds since epoch, UTC. Money is `INTEGER` micro-USD. Token counts, byte offsets and `seq` stay well under 2^53, so `safeIntegers` stays off.
- At open the daemon logs `sqlite_version()` and refuses a `<state>` on a network filesystem (`statfs` type check in the platform module) with a clear error. A `<state>` under iCloud Drive, Dropbox or a similar sync folder (possible only through `DIPO_HOME` or a symlink) gets a warning, because a sync client copying `dipo.db` without its `-wal` file can restore a broken set.
- **Pauses on the daemon thread.** The daemon has one JS thread, so long SQLite calls block every office. Maintenance runs in slices with a budget of 50 ms per call: incremental vacuum in steps of a few hundred pages, `wal_checkpoint(PASSIVE)` routinely and `TRUNCATE` only when idle. `VACUUM INTO` (backups, pre-migration copies) runs in a Bun Worker with its own read-only connection, which takes no write lock [4]. M0 measures the pause of a commit with `synchronous=FULL` and of each maintenance step and adjusts the budget.

### 2. Layout on disk

The office path is always the main worktree: the first entry of `git worktree list --porcelain`. `office open` from a linked worktree resolves to that main worktree through the common directory and opens the same office; it is not treated as a moved repository. The office's repository directory is `<git-common-dir>/dipo/`, resolved with `git rev-parse --path-format=absolute --git-common-dir`. For a normal clone that is `<repo>/.git/dipo/`. It holds no database.

```
<state>/                           # software anchor (0006), mode 0700
  dipo.db, dipo.db-wal, dipo.db-shm  # all offices, keyed by office_id
  backups/
    dipo-<yyyymmdd>.db             # daily VACUUM INTO snapshots
    pre-v<N>-<yyyymmddThhmmss>.db  # before each migration
<repo>/.git/dipo/                  # per office, never tracked, mode 0700
  office.json                      # { officeId, createdAt } marker, written by office init
  runs/<run-id>/
    events.ndjson                  # raw worker stream written by the worker host (0006)
    exit.json                      # written by the host at worker exit
    host.log                       # host diagnostics, capped at 5 MB (0006)
<repo>/.dipo/                      # committed office configuration (0017)
  office.yaml, roles/
  .gitignore                       # one line: office.local.yaml
  office.local.yaml                # machine-local, ignored
```

Outside the repository, unchanged from 0006: the PID lock, `runtime.json`, crash counter and port slot table in `<state>`; the daemon log in `<logs>` (lines carry `office` and `run` fields); all sockets, including `hosts/<run-id>.sock`, in the runtime directory. 0010 keeps worktrees under `../<repo>.worktrees/`. The office list is a table in `dipo.db` (section 3); `<state>/offices.json` is not used.

What is gitignored: nothing extra is needed for `.git/dipo/`, because git never tracks `.git/`. The only ignore rule is `.dipo/.gitignore` with `office.local.yaml`. Office init adds it, only if absent, as a commit in the office-init backlog PR (0010 lane b), and `office uninstall` removes it the same way. The engine never writes it into the maintainer's main checkout. This satisfies 0017 (no runtime file under `.dipo/`, local overrides always ignored) and leaves the root `.gitignore` and `info/exclude` untouched as 0010 requires.

The `office.json` marker carries the `OfficeId` that 0006 matches to detect a moved repository. A fresh clone has no marker and is a new office. A copy made with `cp -r` carries the same marker: when `office open` finds an `OfficeId` already registered and the registered path still exists with that same id, the copy gets a new `OfficeId`, a new `office.json` and no rows, with a notice. Only when the old path is gone is it a move.

A repository on a network filesystem gets a warning at `office open`: two machines opening the same repository each have their own `dipo.db`, and nothing guards their worktrees and git refs against each other. A shared disk is a network filesystem from at least one machine's view, so this check replaces the hostname record the per-office lock used to carry.

### 3. Offices in one file

- **Isolation by key.** Every office-scoped table has `office_id` (`off_<ulid>`, 0005) as the first column of its primary key, and foreign keys between office-scoped tables include it. Each office keeps its own `epoch`, gap-free `seq` and replay floor (0005). Only a few tables are software-wide: `offices`, `schema_migrations`, and the pricing catalogs. A schema test fails when an office-scoped table lacks `office_id` in its key.
- **Office list.** The `offices` table replaces `<state>/offices.json` (0006 decision 4): `office_id`, canonical repository path, display name, time added, `forgotten_at`, plus the per-office `epoch`, `next_seq` and `replay_floor_seq`. Rows without `forgotten_at` are the office list.
- **Forget and purge.** `office.forget` sets `forgotten_at` and keeps every row; opening the repository again finds the same marker and clears it, so history returns. `dipo office purge` (name per DIPO-2, confirm required) deletes all rows of that office and its `<git-common-dir>/dipo/` directory, the rows in one transaction, run in batches inside the time budget of section 1 for a large office. Backups keep the purged rows until they rotate out (section 10).
- **Missing repositories.** Rows of an office whose path no longer exists stay until purge. At daemon start and in the office list the daemon shows a notice for each such office: "path missing; `dipo office open` the new path, or `dipo office purge`".
- **One writer.** The daemon's PID lock (0006 decision 6) covers the file, because only the daemon opens it for writing. There is no per-office lock. The daemon opens `dipo.db` only after its post-bind re-read of `dipo.pid`, and its minute check of `dipo.pid` stops writing before it exits.

### 4. Schema outline

Names are indicative; M0 stories write the DDL. Every table below except `offices`, `schema_migrations`, `pricing_catalogs` and `pricing_rates` carries `office_id` in its primary key (section 3); the "Holds" column leaves it out. "Kept" names the retention tier from section 7: **S** state (1 year), **R** short (7 days), **T** until worktree teardown, **D** 24 hours, **P** permanent until purge.

The database stores facts: things that happened, with time and cause. It stores no display status, column, health or budget share. The engine derives those when it reads and puts the derived view into change-log entries and snapshots (0005 section 6, research idea 1). The `backlog_mirror` table is a cache of what reconcile last read from Backlog.md, never a source of truth.

| Group | Table | Holds | Kept |
|---|---|---|---|
| Software | `offices` | `office_id`, path, display name, added, `forgotten_at`, `epoch`, `next_seq`, `replay_floor_seq` (section 3) | P |
| | `schema_migrations` | version, name, checksum, engine version, applied time. `PRAGMA user_version` mirrors the head | P |
| Identity | `stories` | `key` (`sto_<ulid>`), current `story_id`, `provisional`, frozen branch, Backlog created date, first seen, removed time | P |
| | `story_aliases` | `key`, former id, valid from, retired at (0005 section 2) | P |
| | `backlog_mirror` | per key: content hash, status, tier, role, labels, read time, source (`base`, story branch) | P, overwritten |
| Change log | `change_log` | `seq` (key `office_id, seq`), time, `type`, `tier` (`S` or `R`), `key`, `run_id`, `caused_by` request id, `delta` JSON, `view` JSON | by tier |
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
| | `pricing_catalogs`, `pricing_rates` | software-wide: catalog version, source, effective date, checksum; rate per model per million tokens for input, output, cache write 5 m, cache write 1 h, cache read, in micro-USD | P |
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
- **Usage across offices.** All offices draw from one Max subscription (0001). The daemon sums `usage_totals` and `usage_daily` over all offices in one query for plan-limit use and spend alerts at the software level (0006 decision 1). Office views still read only their own rows.
- **Tokens plus estimated cost.** The binary ships pricing catalogs as versioned files (`pricing/v<N>.json`); the daemon imports any version it lacks at open and never edits an imported version. Each usage row stores tokens and `est_cost_micros` with the `pricing_version` used, so a new catalog can re-price history without losing the old number. Cost is an API-equivalent estimate shown next to plan-limit use, not a bill.
- **Change log feeds the stream.** Each fact write appends one `change_log` row in the same transaction and bumps that office's `offices.next_seq`. A rolled-back transaction consumes no seq, so seq is gap-free per office while written. `epoch` is random per office, stored only in its `offices` row, and replaced on restore (section 10).
- **Processed offsets.** `worker_hosts.processed_offset` and `ingest_cursors.offset` advance in the same transaction as the facts parsed from those bytes (0006 decision 8).
- **Config hash.** `runs.config_hash` is sha256 over the canonical JSON of the effective configuration; `config_snapshots` keeps the content once per office and hash (0017).

### 5. Usage ingestion resumes from a stored offset (research idea 21)

The worker host appends the worker's stream to `events.ndjson`; the engine reads complete lines from `processed_offset` on, parses them, writes facts, usage rows and the new offset in one transaction. The same applies to any transcript file the adapter tails (DIPO-5 decides whether it needs one). After a restart the engine resumes at the stored offset. A partial last line waits for the next read.

When a file's identity changed or its size is below the stored offset:

- **Transcript source** (written by Claude Code, which may rotate or rewrite it): read from 0. The unique `(office_id, agent_id, message_id)` key on `usage_messages` drops what was already counted. After those rows age out, `usage_high_water` skips any message at or before the agent's newest counted one, so tokens are never counted twice.
- **Host event file** (written only by our worker host, append-only): never replayed. A run that is still active parks `interrupted` with the detail "event file changed"; an ended run gets an `engine.notice`. Facts already stored stay.

### 6. Startup reconcile

Runs in the daemon's `recovering` state for each office it loads, after the file-wide migrations (section 9) and the office's worker-host re-attach (0006 decisions 7 and 8), and again on `office.rescan`. Scheduling stays off until it finishes.

1. Check that `office.json` holds the `office_id` of the `offices` row for this path; a mismatch refuses the office with a notice.
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

Each office instance runs retention on its own rows at load and then hourly while loaded, in batches of at most 5,000 rows per transaction so the write lock stays short. Periods are office configuration (`retention.*`, 0017 shell). An office that is not loaded is cleaned at its next load.

| Tier | Default | Deletes |
|---|---|---|
| D | 24 h | `requests` |
| R (short) | 7 days | `change_log` rows with tier R (`work.output`, `work.progress`, `usage.updated`, `work.observed`), `output_chunks`, `usage_messages`, `ingest_cursors` of ended runs, opt-in prompt bodies |
| T | at worktree teardown | `worker_notes`, `context_packs` for that worktree |
| S (state) | 1 year | `change_log` rows with tier S and every S table row whose run or story ended before the cutoff |
| P | never by age | `offices`, identity, `usage_daily`, pricing, current and previous run profile, open journal entries |

- `usage_daily` has one source: each `usage_totals` row when it becomes `final`. Deleting `usage_messages` changes no total, so trends survive both tiers.
- `offices.replay_floor_seq` moves to the lowest seq after which no R-tier row of that office was deleted. A `subscribe` below it, or with another epoch, gets `stream.resetRequired` (0005 section 8). Older S-tier rows stay for `story.detail` and audit, not for replay.
- Run directories: `events.ndjson` is deleted once the run has ended, `processed_offset` equals the exit file's final offset and the run summary exists. Fallback: tier R after run end it is deleted in every case, with an `engine.notice` if it was never fully processed. `host.log` and `exit.json` follow after tier R. With the opt-in `privacy.keepRawEvents` the raw stream is kept for tier R too.
- Daily, when no office has active work: `PRAGMA incremental_vacuum(N)` in slices, `PRAGMA wal_checkpoint(TRUNCATE)`, `PRAGMA optimize` on the whole file, each within the time budget of section 1. Retention batches stay within it too.

### 8. Privacy (research idea 11)

By default the database and run directories hold no assembled prompts, no transcripts and no command bodies.

- Prompts: sha256, size and estimated tokens per part only (0014). The idempotency record holds an args hash (0005).
- Worker output stored in `output_chunks` is assistant text plus one line per tool call with the tool name and target path. Shell command text, tool inputs and tool results from the worker stream are not stored. Output of scripts the engine runs itself (verify, setup, `dev`) is stored in full for tier R; it is the repository's own output.
- The raw `events.ndjson` does contain tool inputs. It exists only while the run needs it (section 7) and lives in a `0700` directory.
- Env files: names and paths only, never contents or hashes (0013).
- Kept on purpose: text the maintainer writes (steer, answer, reject, hold, test notes), worker questions, the worker's final report, worker notes until teardown, and reviewer findings in full (0001).
- One file holds the run detail of every office, so `dipo.db` and its backups are `0600` in the `0700` `<state>`. Deleting a repository does not delete its office's rows; `office purge` does.
- Opt-ins, off by default: `privacy.storePrompts` (assembled prompts, tier R), `privacy.storeCommandBodies` (tool inputs in `output_chunks`), `privacy.keepRawEvents`. Each one is machine-local, so they belong in `.dipo/office.local.yaml` (open question 3). The overview shows when one is on.

### 9. Migrations

- Forward-only, numbered migrations compiled into the binary, each a SQL or TypeScript step with a checksum. `PRAGMA user_version` holds the head; `schema_migrations` records each step.
- They run once for the whole file in the daemon's `recovering` state (0006), before any office's re-attach or reconcile. First a `VACUUM INTO <state>/backups/pre-v<N>-<time>.db` (scheduling is off, so the pause is acceptable). Then each step in its own immediate transaction. Table changes SQLite cannot `ALTER` use the documented rebuild (new table, copy, drop, rename) with `foreign_keys` switched off outside the transaction and `PRAGMA foreign_key_check` before commit.
- A failed step rolls back; no office loads, and the daemon keeps serving software commands with a notice naming the backup.
- A database newer than the binary is refused with "upgrade dipo", as 0017 does for config files. Downgrade means restoring the pre-migration backup.
- A recorded checksum that differs from the binary's step stops the load: someone edited a released migration.
- The change log needs no data migration: events are rendered at send time (0005).
- Tests: a fresh database built from all steps must equal one migrated from a fixture of each released schema version, compared by `sqlite_schema` dump. Before 1.0 the steps may be squashed once, with fixtures regenerated.

### 10. Backups

- Daily, when no office has active work or at least every 24 h, `VACUUM INTO <state>/backups/dipo-<yyyymmdd>.db` from a Bun Worker with a read-only connection (section 1), then `PRAGMA quick_check` on the copy in that Worker. Keep 3 daily and the 2 newest pre-migration copies.
- A plain file copy of `dipo.db` is not a backup while the daemon runs, because recent commits may sit only in the `-wal` file [2]. Time Machine and similar tools may catch an inconsistent set; the daily snapshot is the copy to restore.
- One corrupt file affects every office. After an unclean daemon exit the daemon runs `PRAGMA quick_check` at open; a failure loads no office and shows a notice naming the newest backup, while software commands keep working.
- Restore is a software-level command (`dipo restore <file>`, name per DIPO-2) that unloads every office, copies the file into place, writes a new `epoch` into each `offices` row (`office.json` holds no epoch, so it needs no rewrite), and then reconciles each office. Clients get `stream.resetRequired`. Restoring a single office's rows from a snapshot is possible later because every row carries `office_id`; M0 restores the whole file.
- Losing every copy loses run history, never a project (0001): a new database is created, `office open` registers each repository again from its marker, reconcile rebuilds identity from Backlog.md field-block keys and a rescan rebuilds the code part of the run profile.

### 11. Size estimates

Assumptions to replace with measurements from the first M0 runs: a run lasts about 45 minutes, about 1,500 progress and usage log entries at 600 bytes each, 300 KB of stored worker output, 3 verify loops of 50 KB output, 200 assistant messages; state rows (about 50 state events, verdicts, summary, totals) about 80 KB per run. Indexes add about 30 percent. On top come up to 64 MB of `-wal` file (`journal_size_limit`) and free pages incremental vacuum has not yet returned, roughly 10 percent of the file.

Per office, its share of `dipo.db`; the file is the sum over all offices, and backups hold 5 copies of the whole file:

| Office load | Short tier, steady (7 days) | State tier after 1 year | Share of `dipo.db` | Share of backups (3 + 2) |
|---|---|---|---|---|
| 3 runs a day | about 30 MB | about 90 MB | about 150 MB | about 750 MB |
| 10 runs a day | about 100 MB | about 300 MB | about 500 MB | about 2.5 GB |

The file adds up to 64 MB of WAL once, not per office. A running worker's `events.ndjson` with partial messages can reach tens of MB and is deleted at run end. `dipo stats` (name per DIPO-2) shows table sizes per office so the retention defaults can be tuned.

## Consequences

- Work state lives in one local file outside every repository and working tree, so worktrees, `git clean` and the committed `.dipo/` never touch it, and no root `.gitignore` edit is needed. The repository keeps only the marker and raw run files inside `.git/dipo/`.
- One writer for the whole software makes ordering trivial and avoids `SQLITE_BUSY` inside the daemon. The cost: no other process may write the database, so any future out-of-process tool goes through commands. 0006 option C (one engine process per office) would first need the file split per office, which is mechanical because every row carries `office_id`.
- Isolation between offices is by key, not by file. It rests on the office-scoped handle and the schema test of section 3; a bug there could mix offices, where separate files could not.
- One corrupt file or one failed migration stops every office. Daily backups, pre-migration copies and a whole-file restore are the mitigation.
- Usage across offices against the shared plan limits is one query.
- `synchronous=FULL` costs an fsync per commit; with output batched every 250 ms and usage once per second per run (0005) this stays small, also with several offices busy. M0 measures it.
- The macOS system SQLite 3.51.0 is in the WAL-reset bug range; the single connection avoids the trigger. If a second writer is ever added, ship a fixed SQLite via `setCustomSQLite` first.
- Rows of a deleted repository stay in `dipo.db` until `office purge`; the daemon lists such offices with a notice.
- A Bun Worker for `VACUUM INTO` is one more Bun touchpoint inside the platform module.
- M0 stories: platform database module with pragmas and office-scoped handles; schema and migrations runner with fixtures and the `office_id` key test; `offices` table with `office open`, `forget` and `purge` (replaces 0006's `offices.json` story); change log and request table; ingestion with offsets; reconcile; retention and backup jobs; pricing catalog import. M1 adds verdicts, gates beyond Ready, and spend alerts on `usage_daily` across offices.

## Amends

Decided by the maintainer 2026-10-10 (open question 1) and recorded under "Amendments" in the amended ADRs:

- **0006 decisions 1, 3, 4, 6, 7 and 9:** the office list is the `offices` table in `<state>/dipo.db`, not `<state>/offices.json`; engine instances share the daemon's one connection through office-scoped handles instead of a database handle each; the per-office lock (decision 6, "Second guard, per office") is dropped because the PID lock covers the one file; migrations run once for the file in `recovering`, before any office. Decision 3's sentence "Work state stays in each office" becomes "work state is kept per office in `dipo.db`, keyed by `OfficeId`". A dated line is added under "Amendments" in 0006.
- **0001 "Data ownership" and 0011 "Effects on earlier decisions":** "local database per project" becomes "local work state per project, kept in one central local database keyed by office; never in the repository and never the only copy of a story fact". Dated lines are added under "Amendments" in both.
- **0005 section 6:** the office list is the `offices` table, not `offices.json`. Amended in 0005.
- **0010 worktree table and section 11:** the daemon PID lock, not an office lock, keeps out a second engine; and office init may add the new file `.dipo/.gitignore` (open question 4), while existing ignore files are still never edited. Amended in 0010.

## Open questions for the maintainer

1. **Location — answered 2026-10-10: one central database.** All offices share `<state>/dipo.db`, every office-scoped row keyed by `office_id`, with backups in `<state>/backups/`. The repository keeps only `<git-common-dir>/dipo/` with the marker and run directories.
2. **Durability — answered 2026-10-10: `synchronous=FULL`.** Every commit waits for the disk; write volume is small.
3. **Privacy opt-ins — answered 2026-10-10: machine-local.** `privacy.*` and `retention.*` live in `.dipo/office.local.yaml`; 0017's local allowlist gains both prefixes next to `timeouts.*`.
4. **`.dipo/.gitignore` — answered 2026-10-10: accepted.** Office init adds a new `.dipo/.gitignore` with `office.local.yaml` through the office-init backlog PR; existing ignore files are never edited. 0010 is amended accordingly.
5. **Long-term usage — answered 2026-10-10: kept forever.** `usage_daily` has no retention period.
6. **Backup count — answered 2026-10-10: 3 daily plus 2 pre-migration copies** as the default; the counts are configuration.
7. **Raw worker stream — answered 2026-10-10: deleted at run end** by default; `privacy.keepRawEvents` keeps it for tier R.

## Sources

1. Bun docs, SQLite (WAL recommendation, transactions and their modes, `strict`, `safeIntegers`, `setCustomSQLite`, `serialize`, `fileControl`, macOS WAL sidecar files). https://bun.com/docs/runtime/sqlite
2. SQLite, Write-Ahead Logging (one writer, same host, `-wal` part of the database, persistent mode, checkpoint at 1000 pages, WAL-reset bug fixed in 3.51.3, backported to 3.44.6 and 3.50.7). https://sqlite.org/wal.html
3. SQLite, PRAGMA statements (`busy_timeout`, `synchronous` in WAL, `foreign_keys`, `user_version`, `journal_size_limit`, `auto_vacuum`, `optimize`, `quick_check`). https://sqlite.org/pragma.html
4. SQLite, VACUUM (`VACUUM INTO` is a consistent snapshot and not a write; compared with the backup API). https://sqlite.org/lang_vacuum.html
5. SQLite, ALTER TABLE (rebuild procedure for unsupported changes). https://sqlite.org/lang_altertable.html
6. Local test, Bun 1.3.5 on macOS arm64, 2026-10-10: system SQLite 3.51.0; `busy_timeout` 0 and `foreign_keys` 0 by default; second `BEGIN IMMEDIATE` fails with `database is locked` after the busy timeout; `VACUUM INTO` and `serialize` work; JSON and FTS5 available.
7. OpenClaw docs, Bun compatibility (Linux Bun 1.4.2 statically links SQLite 3.53.2; macOS uses the system SQLite). Secondary source, to confirm in M0. https://docs2.openclaw.ai/install/bun-compatibility.md
8. ADRs 0001, 0004, 0005, 0006, 0011, 0012, 0013, 0017 (draft), 0010, 0014 (draft); research ideas 1, 4, 11, 21 in `docs/research/2026-10-comparable-tools.md`.
