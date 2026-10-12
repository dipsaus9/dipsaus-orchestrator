---
id: DIPO-26
title: Load and validate office configuration from .dipo
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 09:27'
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

Context: the keys belong to their ADRs; this story fixes the shell and the M0 keys. The `yaml` library and `dipo config migrate` wait until a version 2 exists (deferred). `office.reloadConfig` and blocking new runs on an invalid configuration moved to DIPO-27 and DIPO-48 in the M0 review (DIPO-15); this story returns errors as values. Every later key bumps `version` (0017 amendment of 2026-10-12).

M0 key paths of version 1, with default and owner (names not set by an ADR are fixed here):
- `version` (required, `1`).
- `tiers.<S|M|L>.model`, `.effort`, `.budgetTokens`, `.maxTurns`, `.maxMinutes`, `.loops`: 0008 section 9 values.
- `worker.adapter` (`claude-cli`), `worker.allowProjectSettings` (empty): 0008 section 2.
- `permissions.ask` (`when-present`), `permissions.presentMinutes` (10): 0008 section 5.
- `timeouts.workerStallMinutes` (20), `timeouts.workerQuietMinutes` (3), `timeouts.questionWaitMinutes` (15), `timeouts.permissionWaitSeconds` (300): 0008, 0009; `timeouts.scriptMinutes.<script>` (install 15, setup 10, post_create 10, verify 20): 0013 section 1.
- `base` (none), `remote` (`origin`): 0010 section 7.
- `worktree.root` (`../{repo}.worktrees`), `worktree.files`, `worktree.ports`, `worktree.env`, `worktree.post_create` (empty): 0010 section 8.
- `scripts.<name>` (empty): 0013.
- `story.types` (the 0012 F5 list), `story.tiers` (`[S, M, L]`), `story.bannedPhrases` (the 0012 R10 list), `story.titleMax` (100), `story.outcomeMin` (20), `story.criterionMin` (10), `story.slugMax` (40): 0012 section 3, used by the Ready gate (DIPO-30).
- `prompt.budgets` (0014 section 4 values), `prompt.contractMax` (12,000): 0014 section 4.
- `sandbox.toolchainPaths` (`<home>/.bun`, `<home>/.npm`, `<home>/.cache`), `sandbox.registryHosts`, `sandbox.allowRead`, `sandbox.allowedDomains` (empty), `sandbox.allowLocalBinding` (`false`): 0008 section 2.
- `polling.prStateSeconds` (60), `polling.fetchSeconds` (300): M0 review (DIPO-15), used by DIPO-58, DIPO-73 and DIPO-32.
- Only in `office.local.yaml`: `privacy.storePrompts`, `privacy.storeCommandBodies`, `privacy.keepRawEvents` (`false`), `retention.shortDays` (7), `retention.stateDays` (365): 0007 sections 7 and 8.

References: 0017 section 5 (YAML, location, precedence, local allowlist, validation, JSON Schema, versioning); 0008 section 9 (tiers, `worker`, `permissions`, `timeouts`); 0009 consequences (`workerQuietMinutes`, `workerStallMinutes`); 0010 sections 7 and 8 (`base`, remote, `worktree`); 0012 section 3 (types, tier set, banned phrases, thresholds); 0013 (`scripts`); 0014 section 4 (`prompt.budgets`, `prompt.contractMax`); 0007 amendment (privacy and retention local only).

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
    - kind: "automated"
      check: "(unit) the key paths of version 1 equal the list in this story; adding a key to version 1 fails the test."
    - kind: "automated"
      check: "(unit) an invalid file returns the error list and throws nothing."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `Bun.YAML.parse` is reached only through `platform/yaml.ts`; a file with more than one document is an error.
- [ ] #2 Version 1 schemas are `z.strictObject`s; an unknown key, a wrong type or a missing `version` is an error naming the file, the key path and the expected type.
- [ ] #3 Version 1 accepts exactly the M0 key paths listed in the context with their defaults, and a test that compares the schema's key paths with that list fails when a key is added to version 1 without a new version.
- [ ] #4 `office.local.yaml` accepts only `timeouts.*`, `privacy.*` and `retention.*`; `privacy.*` or `retention.*` in `office.yaml` is an error pointing to `.dipo/office.local.yaml`.
- [ ] #5 Merge order is defaults, `office.yaml`, allowed local keys, command flags; objects merge per key, lists and scalars replace.
- [ ] #6 A file with a newer `version` than the binary is refused with a message to upgrade `dipo`.
- [ ] #7 `configHash` is sha256 over the canonical JSON of the effective configuration, and the active local override keys are returned with it.
- [ ] #8 `loadOfficeConfig(dir)` returns either the effective configuration with its hash and local override keys, or the list of errors, and never throws for a bad file, so the office (DIPO-27) can keep its previous configuration.
- [ ] #9 `packages/engine/schema/office.schema.json` is generated with `z.toJSONSchema`, and a contract test fails when it differs from the export.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S11 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
