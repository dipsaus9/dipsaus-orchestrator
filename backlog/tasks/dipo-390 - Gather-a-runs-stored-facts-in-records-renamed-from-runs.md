---
id: DIPO-390
title: 'Gather a run''s stored facts in records/, renamed from runs/'
status: Done
assignee: []
created_date: '2026-10-30 11:22'
updated_date: '2026-10-30 23:05'
labels:
  - 'tier:L'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-381
  - DIPO-389
  - DIPO-368
  - DIPO-384
  - DIPO-386
references:
  - packages/engine/src/runs/
  - packages/engine/src/run/
  - packages/engine/src/ingest/usage.ts
  - packages/engine/src/records/
  - packages/engine/test/
  - tools/lint/oxlint-plugin.js
  - .oxlintrc.json
  - scripts/engine-layers-target.json
  - docs/decisions/0004-language-and-runtime.md
priority: medium
type: chore
ordinal: 368000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the stored facts of runs live in one low directory, records/, below views and ingest, so 28 value imports into a higher layer are gone.

Second move of the DIPO-381 plan (0004, 0005). run/ is the engine's hub: views, ingest, review, retention, scan, stories, worktree and gate-decisions all import its fact modules, and run/ imports them back. The facts move down; the run driver stays.
- Rename `runs/` (agents, worker hosts) to `records/`, and update ENGINE_LAYERS and `scripts/engine-layers-target.json` (drop `runs` there).
- Move `run/records.ts` to `records/run-records.ts`, so no `records/records.ts` exists.
- Move into `records/` under their own names: `run/caps.ts`, `grants.ts`, `lifecycle.ts`, `retired.ts`, `criteria.ts`, `signals.ts`, `park-state.ts`, `select.ts`, `config-snapshot.ts`, `env-secrets.ts`, `live-question.ts`, `resume-policy.ts`, `intents.ts`, `verify-records.ts`, `budget-line.ts`, `open-feedback.ts`, `deciding.ts`, `summary.ts`, and `ingest/usage.ts`. Each imports only base directories and the others of this list.
Removed back-edges (28 imports): ingest -> run (caps, criteria, signals: 4); review -> ingest (usage) and review -> run (caps, env-secrets); runs -> ingest and runs -> run (retired: 3); scan -> run (records); stories -> run (records, select: 3); views -> ingest (usage: 2) and views -> run (records, caps, criteria, signals, park-state, resume-policy: 10); worktree -> run (park-state, records: 2). The imports of retention and gate-decisions into run/ move too; they sit in run's layer, so they were no back-edges.
After this story `bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json` reports 17 back-edges (42 import statements) on main as of 39d36f52.
Depends on DIPO-368, DIPO-384 and DIPO-386, which change `ingest/usage.ts`, `run/` and `runs/worker-hosts.ts`, so the moves do not run beside them.

```dipo
branch: "DIPO-390/run-facts-in-records"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(lint) bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json lists no edge into run/ or runs/ from views, ingest, review, scan, stories or worktree for the moved files"
    - kind: "automated"
      check: "(verify) bun run verify passes with the coarse engine-layers rule"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `runs/` (renamed `records/`), `run/records.ts` (as `records/run-records.ts`), the eighteen other `run/` fact files and `ingest/usage.ts` move with their tests, and every importer, barrel (`index.ts`), path-scoped override in .oxlintrc.json, lint test and comment that names an old path names the new one; no barrel re-exports a file from another directory
- [x] #2 Only paths and import lines change: no function, type or behaviour changes, and no test is removed or skipped
- [x] #3 The coarse dipo/engine-layers rule still passes with no exception, and `bun run verify` passes
- [x] #4 `bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json --files` lists none of the back-edges this story names as removed, and no import it did not list before the story
- [x] #5 `records/` imports values only from the base band and band 2 of 0004 (and from itself), as `bun scripts/engine-graph.ts` shows
- [x] #6 No directory named `runs` and no file `records/records.ts` exist in packages/engine/src, and ENGINE_LAYERS and `scripts/engine-layers-target.json` list `records` instead of `runs`
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Second engine-layer move of the DIPO-381 plan, paths and import lines only: runs/ became records/ (with a records/index.ts barrel that re-exports its own files), 19 run fact files and ingest/usage moved there, run/records.ts became records/run-records.ts. Against the target layers 25 back-edges (71 statements) became 18 (43); the 28 removed imports are exactly the story list. The worker host import ban covers records and its barrel, proven by a lint fixture. Criterion 5 met in substance: records/run-records.ts imports parseSafeChainRecord from box/safe-chain (added by DIPO-376), box sharing records band and target layer, and the import closes no cycle, which ADR 0004 allows.
<!-- SECTION:FINAL_SUMMARY:END -->
