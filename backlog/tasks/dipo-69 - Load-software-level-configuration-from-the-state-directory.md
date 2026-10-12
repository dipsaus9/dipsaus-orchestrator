---
id: DIPO-69
title: Load software-level configuration from the state directory
status: To Do
assignee: []
created_date: '2026-10-12 09:20'
updated_date: '2026-10-12 09:52'
labels:
  - 'tier:S'
milestone: m-0
dependencies:
  - DIPO-19
  - DIPO-23
  - DIPO-25
  - DIPO-26
references:
  - packages/engine/src/config/software.ts
  - packages/client/src/node/config.ts
  - packages/engine/test/config/
  - packages/client/test/
  - packages/contract/
  - packages/daemon/src/
  - packages/client/src/node/index.ts
documentation:
  - docs/decisions/0006-daemon-and-ipc.md
  - docs/decisions/0017-testing-strategy-and-configuration.md
priority: high
type: feature
ordinal: 25300
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo reads the software-level settings in `<state>/config.yaml` with one strict, versioned zod schema shared by the daemon and every client, uses built-in defaults when the file is absent, and refuses a newer `version` with a message to upgrade dipo.

Context: new home story for software-level configuration, added in the M0 review (maintainer decision D11, DIPO-15; 0006 and 0017 amendments of 2026-10-12). Version 1 holds `daemon.autostart` (default `true`, used by client autostart in DIPO-70) and `daemon.autoRestartOnUpgrade` (default `false`, used by DIPO-70). `web.enabled` joins when the browser listener ships, and that addition bumps the file's `version` (0017 amendment). The schema lives in `packages/contract` (zod only, no I/O), so the daemon and `client/node` validate the same way; the daemon reads the file through `engine/src/platform/yaml.ts`, clients through `client/node`. References: 0017 section 5 (shell, strict schemas, versioning, JSON Schema export) and its 2026-10-12 amendments; 0006 decisions 3 (`<state>` anchor), 5 (`daemon.autostart`), 14 (`daemon.autoRestartOnUpgrade`) and the 2026-10-12 amendment.

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-69/load-software-level-configuration-from"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a valid file parses; an absent file gives the defaults; a typo key, a wrong type, a missing `version`, two documents and a newer `version` each fail with the file, key path and expected type."
    - kind: "automated"
      check: "(unit) the key-path list test fails when a key is added to version 1."
    - kind: "automated"
      check: "(contract) the committed `config.schema.json` equals a fresh export."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `SoftwareConfig` version 1 is a `z.strictObject` in `packages/contract` with `version`, `daemon.autostart` (boolean, default `true`) and `daemon.autoRestartOnUpgrade` (boolean, default `false`) and no other key.
- [ ] #2 An absent `<state>/config.yaml` gives the defaults; an unknown key, a wrong type, a missing `version` or more than one YAML document is an error naming the file, the key path and the expected type.
- [ ] #3 A file whose `version` is newer than the binary knows is refused with a message containing `upgrade dipo`.
- [ ] #4 The daemon reads the file at start through `platform/yaml.ts`, and `client/node` reads it before an autostart; both validate with the same contract schema.
- [ ] #5 A test lists the key paths of every schema version and fails when a key is added to an existing version (0017 amendment of 2026-10-12).
- [ ] #6 `packages/contract/schema/config.schema.json` is generated with `z.toJSONSchema`, and a contract test fails when it differs from a fresh export.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Added in the M0 review (DIPO-15, D11) as the home of software-level configuration. Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
