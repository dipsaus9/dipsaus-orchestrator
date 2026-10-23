---
id: DIPO-317
title: >-
  Layer the engine's directories, keep Claude inside its adapter, and close the
  lint gaps
status: Refined
assignee: []
created_date: '2026-10-22 21:00'
updated_date: '2026-10-22 21:00'
labels:
  - 'tier:L'
milestone: m-2
dependencies:
  - DIPO-240
references:
  - tools/lint/oxlint-plugin.js
  - .oxlintrc.json
  - test/lint-boundaries/
  - packages/engine/src/db/database.ts
  - packages/engine/src/pricing/drift.ts
  - packages/engine/src/ingest/usage.ts
  - packages/engine/src/ingest/ingestor.ts
  - packages/engine/src/platform/repo-files.ts
  - packages/engine/src/platform/host.ts
  - packages/engine/src/platform/
  - packages/engine/src/sandbox/
  - packages/engine/src/workers/port.ts
  - packages/engine/src/workers/claude-cli/
  - packages/engine/src/hooks/web-guard.ts
  - packages/engine/src/config/schema.ts
  - packages/engine/src/run/
  - packages/engine/src/index.ts
  - packages/engine/src/workers/scripted.ts
  - packages/cli/src/fake-workspace.ts
  - packages/tui/src/testing/
  - packages/contract/src/fixtures.ts
  - packages/contract/scripts/boundary.test.ts
  - packages/testkit/src/
type: chore
ordinal: 302000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine's sub-directories have a declared direction (core, infrastructure adapters, domain, orchestration), enforced by a lint rule with a fixture. The runtime back-edges that tie the database layer to orchestration are gone. Claude's tool names and model aliases live only in the worker adapter. The package bans also catch dynamic imports. Test fakes leave production source.

Context:
- Most engine sub-directories sit in one import cycle at directory level, and `import/no-cycle` catches only file-level cycles.
- These runtime back-edges remain:
  - `db/database.ts` imports `pricing/import`;
  - `pricing/drift.ts` imports `utcDay` from `ingest/usage`;
  - `ingest/ingestor.ts` imports `run/`;
  - `platform/repo-files.ts` imports `git/`;
  - `platform/` holds the gh adapter (`platform/host.ts`) and Safe-Chain code.
- Claude specifics outside `workers/claude-cli/`:
  - tool names in `run/`, `hooks/` and `hooks/web-guard.ts`;
  - model aliases in `config/schema.ts`.

  The daemon's hook entry goes with DIPO-240.
- Lint gaps:
  - The tui and client bans use `no-restricted-imports`, which ignores `import()` and `require`.
  - Nothing in lint stops engine or daemon from importing client, tui or cli.
  - Contract purity is a regex test over top-level files only (`packages/contract/scripts/boundary.test.ts`).
- `ScriptedWorker` is exported from the engine entry (`engine/src/index.ts`) with no production caller. Other fakes sit in `cli/src/fake-workspace.ts`, `tui/src/testing/` and `contract/src/fixtures.ts`.

```dipo
branch: "DIPO-317/engine-layers-and-lint-gaps"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A `dipo/engine-layers` rule in `tools/lint/oxlint-plugin.js`, on in `.oxlintrc.json`, refuses a value import from a higher engine layer into a lower one. The layer of each sub-directory is listed in one place, and a fixture in `test/lint-boundaries/` proves the rule fires.
- [ ] #2 The back-edges named in the Context are removed, and the rule passes with no exception for them: `utcDay` moves into `platform`; `db` receives the pricing import as a load step; `repo-files` moves next to `git`; the gh host and the Safe-Chain code move out of `platform`; `ingest` reaches `run` through a callback port.
- [ ] #3 Claude's tool names reach `run/` and `hooks/` only through a map that the worker port provides. The office config validates model aliases against a list from the adapter. A lint rule or test shows no Claude tool name outside `workers/claude-cli/`.
- [ ] #4 The package bans for tui, client, engine and daemon are rules of the custom plugin that also catch `import()` and `require`, each proven by a fixture.
- [ ] #5 Contract purity is checked over every source file of contract.
- [ ] #6 `ScriptedWorker` and the other fakes move into testkit or test folders, the engine entry no longer exports them, and the binary build passes.
- [ ] #7 `bun run verify` passes.
<!-- AC:END -->
