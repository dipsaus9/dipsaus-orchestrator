---
id: DIPO-46
title: Gather context through the provider interface with the default provider
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 09:52'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-26
  - DIPO-29
references:
  - packages/engine/src/context/
  - packages/engine/src/db/migrations/
  - packages/engine/test/context/
documentation:
  - docs/decisions/0007-state-database.md
  - docs/decisions/0010-backlog-and-git-integration.md
  - docs/decisions/0014-worker-prompt-assembly.md
priority: high
type: feature
ordinal: 46000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine has the `ContextProvider` interface and a default provider that returns, for a story, its scope files, inputs, matching components of an optional component map and neighbouring tests, within budgets set by the project size class.

Context: the codegraph backend is M1. References: 0014 section 9 (interface, rules, default provider steps 1 to 4), section 4 (size classes from `git ls-files`, per-section and per-item budgets, deterministic line-boundary truncation with marker); 0010 section 10 (component map file and validation); research ideas 23 and 26; 0007 section 4 (`context_packs`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-46/gather-context-through-provider"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) size class boundaries; truncation marker text; determinism across two runs."
    - kind: "automated"
      check: "(integration) a temp repo with a component map gives the expected components and neighbours."
    - kind: "automated"
      check: "(unit) an invalid component map with a cycle is reported."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `ContextProvider`, `ContextRequest` and `ContextPack` match 0014 section 9; providers return items, never prompt prose.
- [ ] #2 The size class is computed from `git ls-files` count: S under 150, M under 500, L under 5,000, XL above.
- [ ] #3 Scope files under the per-item cap are included in full, larger ones as head plus marker; a directory becomes a breadth-first list of at most 200 entries; a missing path is marked new with its parent's file list.
- [ ] #4 Input files are pre-fetched within the `inputs` budget, the path list is never cut, and URLs are listed only.
- [ ] #5 When `.dipo/components.yaml` exists it is validated (names, `depends_on` exists, no cycles, unmatched globs warn), and components matching the scope plus direct neighbours appear with name, purpose and a capped file list.
- [ ] #6 Tests next to scope files by name are listed, not inlined.
- [ ] #7 Truncation cuts on line boundaries and leaves the 0014 marker naming the path and line.
- [ ] #8 The same inputs produce the same pack bytes, and a migration adds `context_packs` with head SHA and blob ids.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S30 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
