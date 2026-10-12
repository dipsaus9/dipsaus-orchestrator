---
id: DIPO-69
title: Load software-level configuration from the state directory
status: In Progress
assignee: []
created_date: '2026-10-12 09:20'
updated_date: '2026-10-12 14:35'
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
  - packages/engine/src/config/keys.ts
  - packages/engine/src/config/load.ts
  - packages/engine/src/config/index.ts
  - packages/engine/src/index.ts
  - packages/engine/src/platform/yaml.ts
  - packages/daemon/test/integration/foreground.test.ts
  - test/software-config/
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
- [x] #1 `SoftwareConfig` version 1 is a `z.strictObject` in `packages/contract` with `version`, `daemon.autostart` (boolean, default `true`) and `daemon.autoRestartOnUpgrade` (boolean, default `false`) and no other key.
- [x] #2 An absent `<state>/config.yaml` gives the defaults; an unknown key, a wrong type, a missing `version` or more than one YAML document is an error naming the file, the key path and the expected type.
- [x] #3 A file whose `version` is newer than the binary knows is refused with a message containing `upgrade dipo`.
- [x] #4 The daemon reads the file at start through `platform/yaml.ts`, and `client/node` reads it before an autostart; both validate with the same contract schema.
- [x] #5 A test lists the key paths of every schema version and fails when a key is added to an existing version (0017 amendment of 2026-10-12).
- [x] #6 `packages/contract/schema/config.schema.json` is generated with `z.toJSONSchema`, and a contract test fails when it differs from a fresh export.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Added in the M0 review (DIPO-15, D11) as the home of software-level configuration. Before cutover: built by hand-run agents.

Implementation (DIPO-69):
- Schema and pure validation in packages/contract/src/config.ts: SoftwareConfigV1 (z.strictObject, version literal 1, daemon.autostart default true, daemon.autoRestartOnUpgrade default false), SOFTWARE_CONFIG_SCHEMAS by version, SOFTWARE_CONFIG_DEFAULTS, resolveSoftwareConfig, the ConfigError shape, checkConfigDocument (mapping, integer version, 'upgrade dipo' for a newer one) and parseSingleYamlDocument(parser, text), which takes the caller's YAML parser so the contract stays I/O-free. config.schema.json joins contractJsonSchemas(), so the existing contract schema test checks it.
- Added refs, with reasons: packages/engine/src/config/keys.ts (the pure schema walkers moved to packages/contract/src/config-keys.ts so client/node can describe errors the same way; keys.ts now re-exports them), packages/engine/src/config/load.ts (uses the contract's ConfigError and checkConfigDocument instead of its own copy; messages unchanged), packages/engine/src/platform/yaml.ts (keeps the only engine Bun.YAML call and delegates the one-document rule to the contract), packages/engine/src/config/index.ts and packages/engine/src/index.ts (export loadSoftwareConfig), packages/daemon/test/integration/foreground.test.ts (daemon reads the file at start and refuses a newer version), test/software-config/ (runs the daemon and client readers on the same files, like test/state-dir).
- Daemon: runForeground loads <state>/config.yaml before the lock; an invalid file prints each error and exits 1. The settings are kept on the run for DIPO-70 (autoRestartOnUpgrade).
- client/node: readSoftwareConfig(state) in src/node/config.ts, the second allowed Bun.YAML caller (the boundary test in engine/test/config/yaml.test.ts names both). DIPO-70 calls it before an autostart; no autostart exists yet.

Review follow-up (PR #44):
- A configuration refusal at daemon start (invalid or newer config.yaml) exits with EXIT_CONFIG = 78 (sysexits EX_CONFIG), exported from packages/contract (config.ts) so DIPO-63 and DIPO-70 can use it without importing the daemon.
- DIPO-63 must keep launchd and systemd from restarting the daemon on exit 78: systemd RestartPreventExitStatus=78; for launchd, a KeepAlive policy that does not relaunch after a configuration exit (for example KeepAlive SuccessfulExit=false is not enough on its own; DIPO-63 picks the policy and tests it).
- DIPO-70's autostart must read <state>/config.yaml first with readSoftwareConfig (client/node) and, when it is invalid or newer, show the error instead of spawning a daemon that would exit 78.
- The engine office loader's issueErrors is now built on the contract's configIssueErrors, with only the office.local.yaml top-level unknown-key wording as an override (unknownKeyProblem option); office messages are unchanged and pinned in packages/engine/test/config/load.test.ts.
<!-- SECTION:NOTES:END -->
