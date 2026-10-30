---
id: DIPO-390
title: 'Gather a run''s stored facts in records/, renamed from runs/'
status: Refined
assignee: []
created_date: '2026-10-30 11:22'
updated_date: '2026-10-30 11:22'
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
Outcome: the stored facts of runs live in one low directory, records/, below views and ingest, so 33 value imports up a layer into run/, runs/ and ingest/ are gone.

Second move of the DIPO-381 plan (0004, 0005). run/ is the engine's hub: views, ingest, review, retention, scan, stories, worktree and gate/store all import its fact modules, and run/ imports them back. The facts move down; the run driver stays.
- Rename `runs/` (agents, worker hosts) to `records/`, and update ENGINE_LAYERS and `scripts/engine-layers-target.json` (drop `runs` there).
- Move into `records/`: `run/records.ts`, `caps.ts`, `grants.ts`, `lifecycle.ts`, `retired.ts`, `criteria.ts`, `signals.ts`, `park-state.ts`, `select.ts`, `config-snapshot.ts`, `env-secrets.ts`, `live-question.ts`, `resume-policy.ts`, `intents.ts`, `verify-records.ts`, `budget-line.ts`, `open-feedback.ts`, `deciding.ts`, `summary.ts`, and `ingest/usage.ts`. Each imports only base directories and the others of this list.
Removed back-edges (33 imports): gate/store -> run (select); ingest -> run (caps, criteria, signals: 4); retention -> run (records, retired, signals: 4); review -> ingest (usage) and review -> run (caps, env-secrets); runs -> ingest and runs -> run (retired: 3); scan -> run (records); stories -> run (records, select: 3); views -> ingest (usage: 2) and views -> run (records, caps, criteria, signals, park-state, resume-policy: 10); worktree -> run (park-state, records: 2).
Depends on DIPO-368, DIPO-384 and DIPO-386, which change `ingest/usage.ts`, `run/` and `runs/worker-hosts.ts`, so the moves do not run beside them.

```dipo
branch: "DIPO-390/run-facts-in-records"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(lint) bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json --strict lists no edge into run/ from views, ingest, review, retention, scan, stories, worktree or gate/store for the moved files"
    - kind: "automated"
      check: "(verify) bun run verify passes with the coarse engine-layers rule"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `runs/` (renamed `records/`), the nineteen `run/` fact files and `ingest/usage.ts` move with their tests, and every importer, barrel (`index.ts`), path-scoped override in .oxlintrc.json, lint test and comment that names an old path names the new one; no barrel re-exports a file from another directory
- [ ] #2 Only paths and import lines change: no function, type or behaviour changes, and no test is removed or skipped
- [ ] #3 `bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json --strict --files` lists none of the back-edges named in the description and no edge it did not list before the story
- [ ] #4 The coarse dipo/engine-layers rule still passes with no exception, and `bun run verify` passes
- [ ] #5 `records/` imports values only from layers 1 to 4 of 0004 and from itself, as `bun scripts/engine-graph.ts --files` shows
- [ ] #6 No directory named `runs` remains in packages/engine/src, and ENGINE_LAYERS and `scripts/engine-layers-target.json` list `records` instead
<!-- AC:END -->
