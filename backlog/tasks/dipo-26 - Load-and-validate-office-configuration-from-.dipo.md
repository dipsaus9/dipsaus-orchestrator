---
id: DIPO-26
title: Load and validate office configuration from .dipo
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-11 18:49'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-18
  - DIPO-20
references:
  - packages/engine/src/config/
  - packages/engine/src/platform/yaml.ts
  - packages/engine/schema/
  - packages/engine/test/config/
documentation:
  - docs/decisions/0007-state-database.md
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0009-tui.md
  - docs/decisions/0010-backlog-and-git-integration.md
  - docs/decisions/0012-story-standard.md
  - docs/decisions/0013-repo-scan-and-script-standard.md
  - docs/decisions/0014-worker-prompt-assembly.md
  - docs/decisions/0017-testing-strategy-and-configuration.md
priority: high
type: feature
ordinal: 26000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine reads `.dipo/office.yaml` and `.dipo/office.local.yaml`, validates them with strict versioned zod schemas, merges them over built-in defaults in the 0017 order, computes a configuration hash, and exports `office.schema.json`.

Context: the keys belong to their ADRs; this story fixes the shell and the M0 keys. The `yaml` library and `dipo config migrate` wait until a version 2 exists (deferred). References: 0017 section 5 (YAML, location, precedence, local allowlist, validation, JSON Schema, versioning); 0008 section 9 (tiers, `worker`, `permissions`, `timeouts`); 0009 consequences (`workerQuietMinutes`, `workerStallMinutes`); 0010 sections 7 and 8 (`base`, remote, `worktree`); 0012 section 3 (types, tier set, banned phrases, thresholds); 0013 (`scripts`); 0014 section 4 (`prompt.budgets`, `prompt.contractMax`); 0007 amendment (privacy and retention local only).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

```dipo
branch: "DIPO-26/load-validate-office-configuration-from"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) valid sample from 0017 parses; typo key, wrong type, two documents, newer version and `privacy.x` in `office.yaml` each fail with the named path."
    - kind: "automated"
      check: "(unit) precedence and merge cases; hash stable across key order."
    - kind: "automated"
      check: "(contract) schema file equals the export."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `Bun.YAML.parse` is reached only through `platform/yaml.ts`; a file with more than one document is an error.
- [ ] #2 Version 1 schemas are `z.strictObject`s; an unknown key, a wrong type or a missing `version` is an error naming the file, the key path and the expected type.
- [ ] #3 Built-in defaults equal 0008 section 9 tiers, timeouts and permissions, 0012 thresholds and banned phrases, 0014 budgets with `contractMax` 12,000, and `worktree.root` `../{repo}.worktrees`.
- [ ] #4 `office.local.yaml` accepts only `timeouts.*`, `privacy.*` and `retention.*`; `privacy.*` or `retention.*` in `office.yaml` is an error pointing to `.dipo/office.local.yaml`.
- [ ] #5 Merge order is defaults, `office.yaml`, allowed local keys, command flags; objects merge per key, lists and scalars replace.
- [ ] #6 A file with a newer `version` than the binary is refused with a message to upgrade `dipo`.
- [ ] #7 `configHash` is sha256 over the canonical JSON of the effective configuration, and the active local override keys are returned with it.
- [ ] #8 `office.reloadConfig` re-reads configuration for an office; an invalid result keeps the previous configuration for running work and blocks new runs with the error.
- [ ] #9 `packages/engine/schema/office.schema.json` is generated with `z.toJSONSchema`, and a contract test fails when it differs from the export.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S11 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
