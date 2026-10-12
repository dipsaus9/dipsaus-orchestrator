---
id: DIPO-26
title: Load and validate office configuration from .dipo
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 12:11'
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
  - packages/engine/package.json
  - bun.lock
  - packages/engine/tsconfig.json
  - packages/engine/src/index.ts
  - packages/engine/scripts/write-schema.ts
  - packages/engine/src/platform/self-check.ts
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
- `worktree.root` (`../{repo}.worktrees`), `worktree.files`, `worktree.ports`, `worktree.env`, `worktree.post_create` (empty): 0010 section 8; `worktree.maxSlots` (20): 0010 section 9.
- `scripts.<name>` (empty): 0013.
- `story.types` (the 0012 F5 list), `story.tiers` (`[S, M, L]`), `story.bannedPhrases` (the 0012 R10 list), `story.titleMax` (100), `story.outcomeMin` (20), `story.criterionMin` (10), `story.slugMax` (40): 0012 section 3, used by the Ready gate (DIPO-30).
- `prompt.budgets` (0014 section 4 values), `prompt.contractMax` (12,000): 0014 section 4.
- `sandbox.toolchainPaths` (`<home>/.bun`, `<home>/.npm`, `<home>/.cache`), `sandbox.registryHosts`, `sandbox.allowRead`, `sandbox.allowedDomains` (empty), `sandbox.allowLocalBinding` (`false`): 0008 section 2.
- `polling.prStateSeconds` (60), `polling.fetchSeconds` (300): M0 review (DIPO-15), used by DIPO-58, DIPO-73 and DIPO-32.
- Only in `office.local.yaml`: `privacy.storePrompts`, `privacy.storeCommandBodies`, `privacy.keepRawEvents` (`false`), `retention.shortDays` (7), `retention.stateDays` (365): 0007 sections 7 and 8.

References: 0017 section 5 (YAML, location, precedence, local allowlist, validation, JSON Schema, versioning); 0008 section 9 (tiers, `worker`, `permissions`, `timeouts`); 0009 consequences (`workerQuietMinutes`, `workerStallMinutes`); 0010 sections 7 and 8 (`base`, remote, `worktree`); 0012 section 3 (types, tier set, banned phrases, thresholds); 0013 (`scripts`); 0014 section 4 (`prompt.budgets`, `prompt.contractMax`); 0007 amendment (privacy and retention local only).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

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
- [x] #1 `Bun.YAML.parse` is reached only through `platform/yaml.ts`; a file with more than one document is an error.
- [x] #2 Version 1 schemas are `z.strictObject`s; an unknown key, a wrong type or a missing `version` is an error naming the file, the key path and the expected type.
- [x] #3 Version 1 accepts exactly the M0 key paths listed in the context with their defaults, and a test that compares the schema's key paths with that list fails when a key is added to version 1 without a new version.
- [x] #4 `office.local.yaml` accepts only `timeouts.*`, `privacy.*` and `retention.*`; `privacy.*` or `retention.*` in `office.yaml` is an error pointing to `.dipo/office.local.yaml`.
- [x] #5 Merge order is defaults, `office.yaml`, allowed local keys, command flags; objects merge per key, lists and scalars replace.
- [x] #6 A file with a newer `version` than the binary is refused with a message to upgrade `dipo`.
- [x] #7 `configHash` is sha256 over the canonical JSON of the effective configuration, and the active local override keys are returned with it.
- [x] #8 `loadOfficeConfig(dir)` returns either the effective configuration with its hash and local override keys, or the list of errors, and never throws for a bad file, so the office (DIPO-27) can keep its previous configuration.
- [x] #9 `packages/engine/schema/office.schema.json` is generated with `z.toJSONSchema`, and a contract test fails when it differs from the export.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S11 (DIPO-15). Before cutover: built by hand-run agents.

Added scope (DIPO-26 implementer): packages/engine/package.json and bun.lock add zod 4.6.5 to the engine (same pin as contract) for the config schemas. packages/engine/tsconfig.json widens rootDir/include to src, scripts and test so the declared test/config/ tests and the schema writer are typechecked. packages/engine/src/index.ts exports the config module from the engine entry. packages/engine/scripts/write-schema.ts writes schema/office.schema.json (mirrors packages/contract/scripts/write-schema.ts; it needs Bun.spawnSync for oxfmt, which the lint bans in engine/src). packages/engine/src/platform/self-check.ts: its YAML probe called Bun.YAML.parse directly; it now goes through platform/yaml.ts so AC #1 holds and a test enforces it.

Implementation (DIPO-26): engine/src/platform/yaml.ts parseYamlDocument (a top-level list and several documents both parse to an array; column-0 document markers after content decide). engine/src/config: schema.ts (OfficeConfigV1 effective schema, OfficeFileV1, OfficeLocalFileV1, OfficeOverridesV1 for command flags, all z.strictObject; file forms derived with every key optional), load.ts (resolveOfficeConfig pure, loadOfficeConfig(dir, {flags}) reads .dipo/; missing files are no layer per D9; errors are {file, path, expected, message} values), merge.ts (mergeLayer, canonicalJson, configHash sha256 hex), keys.ts (schema key paths with * for record names). Names fixed here where no ADR sets them: worktree.ports.{stride, named.*}, worktree.files entries {path, mode copy|link (default copy), required (default false)}, prompt.budgets.<section>.<S|M|L|XL> with sections context, contextItem, inputs, inputsFile, dependencies, background, handoff, feedbackItem, feedbackTotal, feedbackLogLines, diff, nudge, taskMessage (0014 section 4 values); sandbox.toolchainPaths written as ~/.bun, ~/.npm, ~/.cache (the ADR's <home>); story.tiers items restricted to S, M, L because version 1 has only those tier entries. Command flags may not set privacy.* or retention.* (their order is defaults < local only). Regenerate the schema with: bun packages/engine/scripts/write-schema.ts.

Review follow-up (PR #26): worktree.ports.stride defaults to 10 and is required in the effective configuration (0010 open question 6, answered 2026-10-10: stride 10, 20 slots); the earlier note listing it without a default is superseded. Correction to the prompt.budgets note: the letters in prompt.budgets.<section>.<S|M|L|XL> are the 0014 section 4 project size classes counted from git ls-files at pickup (S under 150 files, M under 500, L under 5,000, XL above), not story tiers; the schema says so in a description that reaches office.schema.json. sandbox.toolchainPaths entries must start with ~/ or /; a relative entry is a config error. DIPO-37 and DIPO-40 must expand ~ against the injected home directory, never the process environment. yaml.ts treats a second --- marker as a new document even with no content before it.
<!-- SECTION:NOTES:END -->
