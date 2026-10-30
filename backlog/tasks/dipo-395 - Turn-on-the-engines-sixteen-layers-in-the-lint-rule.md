---
id: DIPO-395
title: Turn on the engine's sixteen layers in the lint rule
status: Refined
assignee: []
created_date: '2026-10-30 11:22'
updated_date: '2026-10-30 11:22'
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
Outcome: `dipo/engine-layers` checks the sixteen engine layers of 0004 with no exception, and the coarse domain layer is gone.

Criterion 4 of DIPO-381 (0004, 0003). After DIPO-389 to DIPO-394 the engine's import graph has no back-edge against the order of 0004.
- ENGINE_LAYERS in `tools/lint/oxlint-plugin.js` holds the sixteen layers of 0004, with the subdirectory entries `workers/claude-cli`, `scan/detect` and `gate/store`; a file belongs to the longest entry that holds it. That entry split is what removes the box <-> workers cycle (box imports `workers/hold.ts`, the adapter imports box) without a move.
- The rule refuses a value import into a higher layer, and between two different entries of one layer; types still cross.
- `scripts/engine-layers-target.json` goes; `bun scripts/engine-graph.ts --strict` reads the plugin's list and reports 0 back-edges.
- 0004 loses its sentence about the coarse layers.
Two other edges the DIPO-318 builder measured need no move: db -> prompts (two migrations render prompt texts) is downward because 0004 puts db above prompts, and the git <-> platform cycle is gone on main (platform imports nothing of git).

```dipo
branch: "DIPO-395/fine-engine-layers"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(lint) bun scripts/engine-graph.ts --strict reports 0 back-edges and 0 cycles, and the fine rule passes on the repository's engine"
    - kind: "automated"
      check: "(lint) test/lint-boundaries has a fixture per layer boundary: an import one layer up is refused, one layer down passes"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 ENGINE_LAYERS holds exactly the sixteen layers of 0004 in its order, subdirectory entries included, with no domain layer; the rule and `scripts/engine-graph.ts` both read that one list, and `scripts/engine-layers-target.json` is deleted
- [ ] #2 For each of the fifteen boundaries between adjacent layers, a test/lint-boundaries fixture shows a value import up the boundary refused and the same import down passing
- [ ] #3 A fixture shows a value import between two entries of one layer refused, a type-only import up a layer passing, and a file under `workers/claude-cli` placed in its own layer, not in `workers`
- [ ] #4 The old rule's cases still fail: a directory in no layer is reported, and a value import from the platform into a higher layer is refused (old rule test kept)
- [ ] #5 Each import form is refused up a layer, the bypass forms included: static import, `export ... from`, `export * from`, dynamic `import()`, `require`, `import.meta.require` and `import x = require()`
- [ ] #6 The rule runs on the real path, the repository's packages/engine/src, in `bun run verify` with no exception and no disable comment, and `bun scripts/engine-graph.ts --strict` reports 0 back-edges and 0 cycles there
- [ ] #7 0004 no longer mentions the coarse layers, and states what the rule now checks
<!-- AC:END -->
