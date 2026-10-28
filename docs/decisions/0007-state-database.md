# 0007 State database

Status: accepted. First written 2026-10-10 (spike DIPO-4). Rewritten 2026-10-24 for the simplified design. The research behind the rewrite is in `docs/research/2026-10-24-simplification-audit.md`.

## Decision in short

One SQLite file holds the run detail of every office, keyed by office, written by the daemon alone. It holds **run detail only**. Story facts belong to Backlog.md and code facts to git and GitHub (0001). A copy the database keeps of either one is a cache that reconcile corrects. There is one retention rule and one kind of backup.

## 1. One file, one writer

- **The file.** `bun:sqlite` behind `engine/src/platform`, on `<state>/dipo.db` with its `-wal` and `-shm` sidecars. `<state>` is `0700` and the files are `0600`. No SQLite extensions.
- **One connection,** opened by the daemon once it holds its lock (0005) and closed last on a clean stop, after a `wal_checkpoint(TRUNCATE)`.
  - Each office's engine instance gets an office-scoped handle on that connection. Every statement it runs binds its own `office_id`, and it has no way to name another office.
  - Writes run as immediate transactions. A read that must match a cursor runs in one deferred transaction.
  - Nothing else writes the file. A maintainer may open it read-only to debug.
- **Pragmas:** `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000`, `journal_size_limit=64 MiB`, and `auto_vacuum=INCREMENTAL` on a new file.
- **Column conventions.** Tables are `STRICT`. Ids are `TEXT`, times are `INTEGER` milliseconds UTC, and money is `INTEGER` micro-USD.
- **Refused locations.** The daemon refuses a `<state>` on a network filesystem.
- **Maintenance in slices.** Long maintenance runs in slices of at most 50 ms, so no office's work stalls behind it.

## 2. Layout on disk

```
<state>/                            # 0005: ~/Library/Application Support/dipo
  dipo.db                           # every office, keyed by office_id
  backups/pre-v<N>-<time>.db        # before each migration; the 2 newest are kept
<repo>/.git/dipo/                   # per office, never tracked
  office.json                       # { officeId, createdAt }, written by office init
  runs/<run>/events.ndjson          # raw session stream from the worker host (0005)
  runs/<run>/exit.json, host.log
<repo>/.dipo/                       # committed office configuration (0017)
  office.yaml
  .gitignore                        # office.local.yaml
  office.local.yaml                 # machine-local, ignored
```

- **The office path** is the main worktree. `<git-common-dir>/dipo/` is the same from every worktree and is never tracked, so it needs no gitignore entry.
- **A copied repository.** A copy made with `cp -r` carries the same marker. When that office is already registered at a path that still exists, the copy becomes a new office.

## 3. Offices in one file

- Every office-scoped table has `office_id` first in its primary key, and a schema test fails when one does not. Only `offices` and `schema_migrations` are software-wide.
- The `offices` table is the office list: id, path, name, time added, `forgotten_at`, and the next change-log seq.
- `office.forget` sets `forgotten_at` and keeps the rows, so opening the repository again brings the history back. Rows nobody uses age out under the one retention rule.

## 4. What the database holds

Run detail, grouped by subject. The prune plan maps every table in the code to one of these groups or removes it.

| Group | Holds |
|---|---|
| Identity | Story keys and their former ids (0005) |
| Cache | `backlog_mirror`: what the engine last read from Backlog.md, keyed by content hash. Never a source of truth |
| Change log | The outbox of section 5 |
| Requests | Stored replies of run commands (0005), deleted when their run ends |
| Runs | Runs, agents, steps, intents, the caps snapshot and grants (0020), and one outcome row per ended run with what retro needs |
| Process | Worker hosts and their processed offsets (0005) |
| Usage | Usage per message (deduplicated by message id), totals per run, agent and model, including the cost the CLI reported (0008), and a daily rollup |
| Review and merge | Gates and their decisions, reviewer verdicts keyed on the code tree, story PRs, feedback items with their signatures, and the maintainer's tests (`acceptance_tests`) with their result per head (0002) |
| Parks and questions | Park detail and history, questions and answers. The current park state is Backlog.md's (section 6) |
| Claims | One live claim per story and per branch, enforced by unique indexes, plus released branches |
| Backlog lane | The journal of planning operations and backlog PRs (0010) |
| Run profile | Scans, profiles, capabilities, confirmations and proposals (0013) |
| Prompts | Prompt part sizes and, when stored, prompt texts, plus worker notes for the handoff (0014) |
| Config | Snapshots of the effective office configuration, keyed by hash (0017) |
| Proposals | Worker proposals for the desk (0020) |

The database stores facts. Display status, columns, health and budget shares are derived by engine code when it reads, and go out in change-log entries and snapshots (0005).

## 5. The change log

- Each fact write appends one `change_log` row in the same transaction: seq, time, type, story key, run, the request that caused it, the delta and the derived view. It also bumps the office's next seq.
- A rolled-back transaction uses no seq, so seq has no gaps.
- A subscriber whose cursor is older than the oldest stored row, or beyond the last one, gets `stream.resetRequired` (0005). There is no epoch and no replay-floor column; the oldest row decides.

## 6. Reconcile

Reconcile runs for each office at load, in the daemon's `recovering` state, and on `office.rescan`. Scheduling stays off until it finishes. **Backlog.md and git win. The database corrects its own copy and shows a notice. It never decides between two copies, and it never edits Backlog.md or git to match itself.**

1. Check that `office.json` names the office's id; a mismatch refuses the office.
2. Finish pending backlog lane operations from the journal (0010).
3. Read every story through the Backlog CLI on the base. A claimed story is also read on its story branch.
4. Read git and GitHub: branches, the recorded SHAs, the PR states.

| Fact | Owner | On a mismatch |
|---|---|---|
| Story fields (title, criteria, tier, references, test plan, flags) | Backlog.md | Update the cache. A change on a running story is shown to the maintainer, and the run continues |
| Status and park reason | Backlog.md: the story branch while claimed, the base otherwise; `Done` on the base always wins (0020) | Correct the database's park and run records to match. A run whose story left In Progress or In Review is ended and its session stopped |
| Story identity | Backlog.md | An id that vanished is `Removed` (0005) |
| Branches, SHAs, merges | git and GitHub | Correct the claims. A merged PR is Done (0002) |
| Run detail | The database | Not compared; Backlog.md and git hold none of it |
| Worker process liveness | The OS | Re-attach or park (0005) |

## 7. Ingestion from an offset

The worker host appends the session's stream to `events.ndjson`. The engine reads complete lines from the stored offset, parses them through the adapter (0008), and writes the facts, the usage rows and the new offset in one transaction. A partial last line waits for the next read. A file that shrank or changed identity is never replayed: the run parks `worker-failed` with the detail "event file changed".

## 8. One retention rule

- **The rule.** Everything about a run that ended more than `retention.days` ago (default 30) is deleted: its change-log rows, output, usage messages, steps, verdicts and feedback.
- **Kept.** The run's outcome row and the daily usage rollup are kept, for retro and trends.
- **When it runs.** At office load and then hourly, in batches of at most 5,000 rows.
- **Run directories.** `events.ndjson` is deleted as soon as its run has ended and was processed to its final offset. The rest of the run directory goes with the rule.
- **Daily upkeep** while no work is active: incremental vacuum in slices, a truncating checkpoint, and `PRAGMA optimize`.

## 9. Privacy

- Prompts are stored as sizes and hashes per part. The assembled prompt text is stored too while `privacy.storePrompts` is on (the default).
- Worker output is assistant text plus one line per tool call. The command bodies of tool calls are stored while `privacy.storeCommandBodies` is on (the default). Thinking text is never stored.
- `events.ndjson` holds tool inputs and lives only while the run needs it, unless `privacy.keepRawEvents` (default off) keeps it for the retention period.
- Env files are recorded by name and path only, never their contents.
- `privacy.*` and `retention.*` are machine-local: they are accepted only in `.dipo/office.local.yaml` (0017). The overview shows which privacy settings are on.
- Kept on purpose: the maintainer's own text, worker questions and reports, and reviewer findings in full.

## 10. Migrations and the one backup

- **Migrations.** Forward-only, numbered steps compiled into the binary, each with a checksum. `PRAGMA user_version` holds the head, and `schema_migrations` records each step.
- **Order.** They run once for the whole file in `recovering`, before any office loads. Each step runs in its own transaction.
- **The backup.** Before the first step, dipo writes `VACUUM INTO backups/pre-v<N>-<time>.db`. A fresh database gets no backup. The two newest are kept. This is the only backup.
- **Failure.** A failed step rolls back, and the daemon stays in `recovering` with `database.unavailable` and the backup's name (0005). An edited step (checksum mismatch) is treated the same way. A database newer than the binary is refused with "upgrade dipo".
- **Tests.** A database built from all steps must equal one migrated from each released schema, compared by schema dump. Before 1.0 the steps may be squashed once.
- **Losing the database** loses run history, never a project (0001). A new file is created. `office open` registers each repository again from its marker, and reconcile and a rescan rebuild the rest from Backlog.md, git and the repository.

## Replaced

- Five retention tiers (D, R, T, S, P) with their own periods (2026-10-10). Replaced by one rule plus the kept outcome and rollup (2026-10-24).
- Daily `VACUUM INTO` backups, a `quick_check` after unclean exits, `dipo restore` with a new epoch, and `office purge` (2026-10-10, 2026-10-12). Replaced by the pre-migration backup only (2026-10-24), since losing the file loses only history.
- The per-office epoch and replay floor (2026-10-10). Replaced by the oldest stored row (2026-10-24).
- Pricing catalogs, rate tables and drift checks (2026-10-10). Replaced by the cost the CLI reports (0008, 2026-10-24).
- Park state kept both in the task file and in `parks`, with reconcile choosing between them. Replaced by: Backlog.md owns the state, `parks` holds detail and history (2026-10-24).
- Identity matching by field-block key, frozen branch and created date after a database loss (2026-10-10). Replaced by: a vanished id is Removed (0005, 2026-10-24).
- `merge_slot`, `nudge_sources`, `base_verifies`, `verify_results`, the pricing tables, transcript cursors and `usage_high_water`. Each served a mechanism that is gone (2026-10-24).
- The 24-hour request table for every command. Replaced by stored replies for run commands only (0005, 2026-10-24).
- Linux paths and the systemd log location (2026-10-10). macOS only (0004).
