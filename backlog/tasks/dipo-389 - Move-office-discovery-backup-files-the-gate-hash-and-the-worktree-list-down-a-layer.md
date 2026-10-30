---
id: DIPO-389
title: >-
  Move office discovery, backup files, the gate hash and the worktree list down
  a layer
status: Refined
assignee: []
created_date: '2026-10-30 11:22'
updated_date: '2026-10-30 11:22'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-381
references:
  - packages/engine/src/office/repository.ts
  - packages/engine/src/backup/files.ts
  - packages/engine/src/gate/store/hash.ts
  - packages/engine/src/gate/index.ts
  - packages/engine/src/reconcile/git-facts.ts
  - tools/lint/oxlint-plugin.js
  - scripts/engine-layers-target.json
  - docs/decisions/0004-language-and-runtime.md
priority: medium
type: chore
ordinal: 367000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: five small files sit in the engine layer 0004 gives them, so five back-edges and the backup, db and retention import cycle are gone.

First move of the DIPO-381 plan (0004, 0001). It removes these value imports up a layer:
- commands -> office: `commands/execute.ts` imports `office/repository.ts`. Move `office/repository.ts` to `git/repository.ts`: office discovery runs git through the git module.
- db -> backup: `db/migrations.ts` imports `backup/files.ts`, which closes the cycle backup -> retention -> db -> backup. Move `backup/files.ts` to `db/backup-files.ts`: pre-migration backups are the database's own files.
- stories -> gate/store: `stories/read.ts` imports `gate/store/hash.ts`. Move it to `gate/hash.ts`: the content hash is a pure function of the gate rules.
- gate -> gate/store: the barrel `gate/index.ts` re-exports `./store`. Remove that re-export; callers import `gate/store` directly.
- worktree -> reconcile: `worktree/leftovers.ts` imports `reconcile/git-facts.ts`. Move `git-facts.ts` to `worktree/`: it lists worktrees and claim commits.
It also drops the stale `pricing` entry from ENGINE_LAYERS (the directory went with DIPO-354).

```dipo
branch: "DIPO-389/small-layer-moves"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(lint) bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json --strict no longer lists commands -> office, db -> backup, stories -> gate/store, gate -> gate/store or worktree -> reconcile"
    - kind: "automated"
      check: "(verify) bun run verify passes with the coarse engine-layers rule"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `office/repository.ts`, `backup/files.ts`, `gate/store/hash.ts` and `reconcile/git-facts.ts` move with their tests, and every importer, barrel (`index.ts`), path-scoped override in .oxlintrc.json, lint test and comment that names an old path names the new one; no barrel re-exports a file from another directory
- [ ] #2 Only paths and import lines change: no function, type or behaviour changes, and no test is removed or skipped
- [ ] #3 `bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json --strict --files` lists none of the back-edges named in the description and no edge it did not list before the story
- [ ] #4 The coarse dipo/engine-layers rule still passes with no exception, and `bun run verify` passes
- [ ] #5 `gate/index.ts` no longer re-exports `gate/store`, and ENGINE_LAYERS no longer lists `pricing`
- [ ] #6 `bun scripts/engine-graph.ts` lists no cycle of backup, db and retention
<!-- AC:END -->
