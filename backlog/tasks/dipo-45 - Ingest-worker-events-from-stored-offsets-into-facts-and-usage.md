---
id: DIPO-45
title: Ingest worker events from stored offsets into facts and usage
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 09:32'
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

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

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
- [ ] #1 Migrations add `agents`, `usage_messages`, `usage_totals`, `usage_daily`, `output_chunks` and `ingest_cursors`.
- [ ] #2 Each pass reads from `processed_offset`, ignores a partial last line, and commits facts and the new offset together; a crash between reads neither skips nor repeats an event.
- [ ] #3 Stored worker output holds assistant text plus one line per tool call with tool name and target path; shell command text, tool inputs and tool results are not stored.
- [ ] #4 `usage_messages` is unique on office, agent and message id; `usage_totals` updates in the same transaction; `usage_daily` is fed only when a totals row becomes final.
- [ ] #5 Budget tokens equal input plus output plus cache creation; cache reads are stored and shown, never counted.
- [ ] #6 `work.output` flushes per run every 250 ms or 16 KiB and `usage.updated` at most once per second, on the injected clock; a state change flushes pending output first.
- [ ] #7 A host event file smaller than the stored offset or with another identity stops ingestion for that run and reports `ingest.fileChanged` for it; parking the run `interrupted` is DIPO-57.
- [ ] #8 A pass for a run starts when its host announces `advanced` on its socket (DIPO-44), with a `stat` poll every 1 s on the injected clock as fallback; `fs.watch` is not used.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S29 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
