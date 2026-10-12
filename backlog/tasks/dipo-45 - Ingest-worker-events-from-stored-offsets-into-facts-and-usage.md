---
id: DIPO-45
title: Ingest worker events from stored offsets into facts and usage
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 14:35'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-22
  - DIPO-42
  - DIPO-44
references:
  - packages/engine/src/ingest/
  - packages/engine/src/db/migrations/
  - packages/engine/test/ingest/
  - packages/engine/src/workers/types.ts
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/src/workers/claude-cli/schema.ts
  - packages/engine/test/workers/interpret.test.ts
  - packages/engine/test/workers/scripts.ts
  - packages/engine/src/db/schema.ts
  - packages/engine/src/index.ts
  - packages/engine/test/workers/scripted.test.ts
documentation:
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0006-daemon-and-ipc.md
  - docs/decisions/0007-state-database.md
priority: high
type: feature
ordinal: 45000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine reads complete lines of each run's `events.ndjson` from the stored processed offset, interprets them, and in one transaction writes the derived facts, output chunks, usage rows, change-log entries and the new offset, emitting debounced `work.output` and `usage.updated` events.

Context: pricing of usage is DIPO-62; `est_cost_micros` stays empty until then. Starting ingestion for each new run is wired in DIPO-74, and parking a run whose event file changed is DIPO-57, so this story reports the change instead (M0 review, DIPO-15). Usage of a run with no story (a later `session` run, 0007 amendment of 2026-10-12) is stored under the office like any other run. References: 0007 sections 4 (`agents`, `usage_messages`, `usage_totals`, `usage_daily`, `output_chunks`, `ingest_cursors`), 5 (offset ingestion, host file changed means `interrupted`), 8 (privacy of stored output); 0005 section 6 (debounce 250 ms or 16 KiB, usage at most 1 per second, state changes flush output first); 0006 decision 8 (offset in the same transaction).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-45/ingest-worker-events-from-stored-offsets"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) replay `success-tools-subagent`; usage totals equal the recording's numbers; output chunks hold no tool input."
    - kind: "automated"
      check: "(engine) stop ingestion mid-file and restart; no duplicate usage rows."
    - kind: "automated"
      check: "(engine) debounce windows on the manual clock."
    - kind: "automated"
      check: "(engine) with no `advanced` announcement, the 1 s poll on the manual clock picks up appended lines."
    - kind: "automated"
      check: "(engine) a truncated event file reports `ingest.fileChanged` and ingests nothing more for that run."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Migrations add `agents`, `usage_messages`, `usage_totals`, `usage_daily`, `output_chunks` and `ingest_cursors`.
- [x] #2 Each pass reads from `processed_offset`, ignores a partial last line, and commits facts and the new offset together; a crash between reads neither skips nor repeats an event.
- [x] #3 Stored worker output holds assistant text plus one line per tool call with tool name and target path; shell command text, tool inputs and tool results are not stored.
- [x] #4 `usage_messages` is unique on office, agent and message id; `usage_totals` updates in the same transaction; `usage_daily` is fed only when a totals row becomes final.
- [x] #5 Budget tokens equal input plus output plus cache creation; cache reads are stored and shown, never counted.
- [x] #6 `work.output` flushes per run every 250 ms or 16 KiB and `usage.updated` at most once per second, on the injected clock; a state change flushes pending output first.
- [x] #7 A host event file smaller than the stored offset or with another identity stops ingestion for that run and reports `ingest.fileChanged` for it; parking the run `interrupted` is DIPO-57.
- [x] #8 A pass for a run starts when its host announces `advanced` on its socket (DIPO-44), with a `stat` poll every 1 s on the injected clock as fallback; `fs.watch` is not used.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S29 (DIPO-15). Before cutover: built by hand-run agents.

Added references: workers/types.ts, claude-cli/interpret.ts and schema.ts (neutral WorkerEvent `initRejected { reason }`, emitted once before `started`, so ingestion can mark the agent and the engine can stop the worker at once; DIPO-42 follow-up) and test/workers/interpret.test.ts (its unit test).

Added references: test/workers/scripts.ts (new script output-and-usage for the debounce tests; every ScriptedWorker script lives there), db/schema.ts (registers migration 4) and src/index.ts (exports Ingestor, fileChangedRuns, finalizeAgentUsage, readUsage).

Implementation: migration 4 (`agents`, `usage_messages`, `usage_totals`, `usage_daily`, `output_chunks`, `ingest_cursors`); `ingest/event-file.ts` (stat identity, complete lines from an offset), `ingest/output.ts` (stored text), `ingest/usage.ts` (message rows, totals, turn totals, finalize into usage_daily, contract Usage), `ingest/ingestor.ts` (`Ingestor`: track, pass, announce/watch, 1 s poll, debounce timers, flushOutput, fileChanged). Tests in `test/ingest/ingest.test.ts` cover the five test-plan entries plus a crash inside a pass, a replaced file, a session run and an init rejection.

Decisions taken inside the ADRs:
- The read position is `worker_hosts.processed_offset`; `ingest_cursors` keeps identity (device, inode, size), the same offset, last line hash, the adapter's parse state (JSON) and the emitted-output mark, all written in the pass transaction. The parse state is stored so a restart resumes the parser exactly where the offset is.
- Debounce sits between stored facts and the log: output chunks and usage rows are written with the offset; `work.output` (per run, first pending + 250 ms, or at once at 16 KiB) and `usage.updated` (first at once, then at most one per 1000 ms) are change-log entries written when due, so a restart loses nothing (pending output goes out on the timer after `track`). An exit, an init rejection and a file change flush pending output first in the same transaction; `flushOutput(run)` is the hook for other state changes.
- Stored output: main-agent text, plus `[tool] <name> <path>` per main-agent tool call (subagent tool calls show only as the Agent call).
- `usage_totals` is keyed per run, agent and model (0008: usage per model). A `turn` replaces every model's tokens with the adapter's cumulative totals; turns (summed `numTurns`, 0008 section 6) and elapsed ms (last minus first host line time) sit on the agent's main model row. The agent's totals become final when its `exit` line is ingested; each row then feeds `usage_daily` once, `runs` and `budget_limit_sum` count a run once per day, role, tier and model.
- `usage_messages` has one `cache_create` column: the neutral `usage` event carries no 5 m / 1 h split. Add the split with pricing (DIPO-62) if the catalog needs it.
- `ingest.fileChanged` is an `engine.notice` (level warn, code `ingest.fileChanged`) plus `changed_at`/`changed_detail` on the cursor, the `onFileChanged` hook and `fileChangedRuns(office)` for DIPO-57. Missing file with offset > 0, smaller than the offset, or another device/inode all count.
- A run without a WorkRef (session run) stores agent, usage and output under the office but writes no `work.output`/`usage.updated`, because WorkRef requires a story.
- Run context (role, tier, budget limit, WorkRef, planned model) is passed by the caller in `IngestTarget`, since `runs` arrives with DIPO-48; DIPO-74 wires `track` and `watch(hostClient)` per run.

DIPO-42 follow-ups:
- Init rejection: new neutral WorkerEvent `initRejected { reason }`, emitted before `started`; ingestion records it on `agents.init_rejected` and calls `onInitRejected` so the caller stops the worker and does not treat it as a live start (stop and park worker-failed: DIPO-74/DIPO-50).
- Counter reset / resume double count: not solved here. Ingestion takes the adapter's `initialState` from the caller, so a resumed session must pass the stored totals and baseline (`initialState({ totals, baseline })`); choosing them, and telling a counter reset from restored spend, belongs to the resume story DIPO-51.

Review fixes (PR #43):
- Cache creation split (0007 section 4): the neutral `usage` event carries `output`, `cacheCreate5m` and `cacheCreate1h` (`cacheCreate` is their sum; the Claude event schema enforces it). The Claude adapter maps `usage.cache_creation.ephemeral_1h_input_tokens` (the DIPO-41 recordings keep both ephemeral fields); the rest, or all of it when the split is missing, counts as 5 minute. `usage_messages`, `usage_totals` and `usage_daily` have `cache_create_5m` and `cache_create_1h` (migration 4 changed in place, unmerged). In `usage_totals` the parts are sums over counted messages; `cache_create` takes the adapter's cumulative total at each turn end. Budget used stays input + output + cache_create.
- `usage_messages.output` is the per-message `output_tokens` as reported (may be a placeholder); run totals take output only from turn ends.
- `usage.updated` is marked sent only after its transaction commits, so a rolled-back one is sent again.
- Each pass re-reads the last processed line (`last_line_bytes`, `last_line_hash`) and reports `ingest.fileChanged` when it no longer matches; the file identity is recorded as soon as the file exists, so a replacement before the first complete line is caught.
- Added reference: test/workers/scripted.test.ts (schema refuses a usage event whose parts do not add up).
- For later stories: DIPO-51 and DIPO-57 must call `finalizeAgentUsage` at run end when no exit line was ingested (host died); pending output per run assumes one agent at a time, multi-agent pending is a later concern.

Re-review fix (PR #43): every usage table keeps cache_create = cache_create_5m + cache_create_1h, enforced by a CHECK in migration 4. At a turn end usage_totals caps the 1 hour part at the adapter's new total and the 5 minute part is the rest (the adapter's per-message rule). Pricing (DIPO-62) reads the parts directly. Tested after the pause-now and success-tools-subagent replays.
<!-- SECTION:NOTES:END -->
