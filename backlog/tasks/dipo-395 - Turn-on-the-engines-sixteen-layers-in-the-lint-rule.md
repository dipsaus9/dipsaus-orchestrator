---
id: DIPO-395
title: Turn on the engine's fine layer order and the directory cycle check
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
  - DIPO-394
references:
  - tools/lint/oxlint-plugin.js
  - .oxlintrc.json
  - test/lint-boundaries/lint-engine-layers.test.ts
  - test/lint-boundaries/fixtures/
  - scripts/engine-graph.ts
  - scripts/engine-layers-target.json
  - docs/decisions/0004-language-and-runtime.md
priority: medium
type: chore
ordinal: 373000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo/engine-layers` checks the fine layer order with no exception, `bun run verify` refuses any directory cycle in the engine, and the coarse domain layer is gone.

Criterion 4 of DIPO-381 (0004, 0003). After DIPO-389 to DIPO-394 the engine's import graph has no back-edge against the target order and no directory cycle.
What the check enforces, as 0004 says: a value import into a higher layer of the plugin's order is refused by the lint rule; an import between two entries of one layer is allowed when it closes no cycle; a directory cycle is refused by `bun scripts/engine-graph.ts --check`, which a test runs in `bun run verify`. Types still cross both.
- ENGINE_LAYERS in `tools/lint/oxlint-plugin.js` holds the order of `scripts/engine-layers-target.json`, with the subdirectory entries `workers/claude-cli` and `scan/detect`; a file belongs to the longest entry that holds it. That entry split removes the box <-> workers cycle (box imports `workers/hold.ts`, the adapter imports box) without a move.
- `scripts/engine-layers-target.json` is deleted; `bun scripts/engine-graph.ts` reads the plugin's list.
- 0004 loses its sentence about the coarse layers and the target file.
Two edges the DIPO-318 builder measured need no move: db -> prompts (two migrations render prompt texts) goes down because 0004 puts db above prompts, and the git <-> platform cycle is gone on main (platform imports nothing of git).

```dipo
branch: "DIPO-395/fine-engine-layers"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(lint) bun scripts/engine-graph.ts --check reports 0 back-edges and 0 cycles, and the fine rule passes on the repository's engine"
    - kind: "automated"
      check: "(lint) test/lint-boundaries has a fixture per layer boundary: an import one layer up is refused, one layer down passes"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 ENGINE_LAYERS holds the order of `scripts/engine-layers-target.json` with no domain layer and no `runs` or `gate/store` entry, every directory in a band of 0004 sits in a layer of that band, the rule and `scripts/engine-graph.ts` both read that one list, and `scripts/engine-layers-target.json` is deleted
- [ ] #2 For each boundary between adjacent layers, a test/lint-boundaries fixture shows a value import up the boundary refused and the same import down passing
- [ ] #3 A fixture shows a value import between two entries of one layer passing, a type-only import up a layer passing, and a file under `workers/claude-cli` placed in its own layer, not in `workers`
- [ ] #4 A test in `bun run verify` runs the directory cycle check on packages/engine/src and fails on a cycle: shown with a fixture tree where two directories of one layer import each other
- [ ] #5 The old rule's cases still fail: a directory in no layer is reported, and a value import from the platform into a higher layer is refused (old rule test kept)
- [ ] #6 Each import form is refused up a layer, the bypass forms included: static import, `export ... from`, `export * from`, dynamic `import()`, `require`, `import.meta.require` and `import x = require()`
- [ ] #7 The rule and the cycle check run on the real path, the repository's packages/engine/src, in `bun run verify` with no exception and no disable comment
- [ ] #8 0004 no longer mentions the coarse layers or the target file, and states what the rule and the cycle check enforce
<!-- AC:END -->
