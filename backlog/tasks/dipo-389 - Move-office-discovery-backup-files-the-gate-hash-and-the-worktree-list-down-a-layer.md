---
id: DIPO-389
title: >-
  Move office discovery, backup files, gate decisions and the worktree list to
  their layers
status: Refined
assignee: []
created_date: '2026-10-30 11:22'
updated_date: '2026-10-30 11:44'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-381
references:
  - packages/engine/src/office/repository.ts
  - packages/engine/src/backup/files.ts
  - packages/engine/src/gate/store/
  - packages/engine/src/gate/index.ts
  - packages/engine/src/reconcile/git-facts.ts
  - packages/engine/src/gate-decisions/
  - tools/lint/oxlint-plugin.js
  - scripts/engine-layers-target.json
  - docs/decisions/0004-language-and-runtime.md
priority: medium
type: chore
ordinal: 367000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: office discovery, backup files, the gate hash, gate decisions and the worktree list sit where 0004's order puts them, so five back-edges and the backup, db and retention import cycle are gone.

First move of the DIPO-381 plan (0004, 0001). It removes these value imports into a higher layer (5 imports):
- commands -> office: `commands/execute.ts` imports `office/repository.ts`. Move it to `git/repository.ts`: office discovery runs git through the git module.
- db -> backup: `db/migrations.ts` imports `backup/files.ts`, which closes the cycle backup -> retention -> db -> backup. Move it to `db/backup-files.ts`: pre-migration backups are the database's own files.
- stories -> gate/store: `stories/read.ts` imports `gate/store/hash.ts`. Move it to `gate/hash.ts`: the content hash is a pure function of the gate rules.
- gate -> gate/store: the barrel `gate/index.ts` re-exports `./store`. Remove that re-export.
- worktree -> reconcile: `worktree/leftovers.ts` imports `reconcile/git-facts.ts`. Move `git-facts.ts` to `worktree/`: it lists worktrees and claim commits.
It also moves the rest of `gate/store/` to a top-level `gate-decisions/` (stored gate decisions and the `story.gate` read), which sits eight layers above `gate` in 0004's order, so no subdirectory entry is needed for it. `scripts/engine-layers-target.json` drops `gate/store`, ENGINE_LAYERS lists `gate-decisions` in the domain layer and drops the stale `pricing` (gone with DIPO-354).
One import changes directory pair and stays a back-edge: `worktree/git-facts.ts -> story-pr/records.ts` joins the already listed worktree -> story-pr; DIPO-391 removes it.
After this story `bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json` reports 24 back-edges (70 import statements) and 1 directory cycle on main as of 39d36f52.

```dipo
branch: "DIPO-389/small-layer-moves"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(lint) bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json no longer lists commands -> office, db -> backup, stories -> gate/store, gate -> gate/store or worktree -> reconcile, and lists no cycle of backup, db and retention"
    - kind: "automated"
      check: "(verify) bun run verify passes with the coarse engine-layers rule"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `office/repository.ts`, `backup/files.ts`, `gate/store/` (its hash to `gate/`, the rest to `gate-decisions/`) and `reconcile/git-facts.ts` move with their tests, and every importer, barrel (`index.ts`), path-scoped override in .oxlintrc.json, lint test and comment that names an old path names the new one; no barrel re-exports a file from another directory
- [ ] #2 Only paths and import lines change: no function, type or behaviour changes, and no test is removed or skipped
- [ ] #3 The coarse dipo/engine-layers rule still passes with no exception, and `bun run verify` passes
- [ ] #4 `bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json --files` lists none of the back-edges this story names as removed, and no import it did not list before the story, except `worktree/git-facts.ts -> story-pr/records.ts`, which stays on worktree -> story-pr until DIPO-391
- [ ] #5 `gate/index.ts` no longer re-exports `gate/store`, no `gate/store/` directory remains, ENGINE_LAYERS lists `gate-decisions` and no longer lists `pricing`, and `scripts/engine-layers-target.json` no longer lists `gate/store`
- [ ] #6 `bun scripts/engine-graph.ts` lists no cycle of backup, db and retention
<!-- AC:END -->
