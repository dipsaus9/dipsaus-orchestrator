---
id: DIPO-19
title: 'Define the contract envelope, ids, errors and software-level messages'
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 11:31'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-16
references:
  - packages/contract/
  - package.json
documentation:
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0006-daemon-and-ipc.md
  - docs/decisions/0009-tui.md
  - docs/decisions/0017-testing-strategy-and-configuration.md
priority: high
type: feature
ordinal: 19000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `packages/contract` holds the zod schemas for ids, frames, command and read envelopes, errors, cursors, contract versioning and the software-level commands, reads and events, with a JSON Schema export checked by a contract test.

Context: the work model (stories, runs, views) follows in DIPO-20 so each story stays reviewable. References: 0005 sections 2 (ids), 3 (envelopes and frames), 4 (`office.*`, `daemon.*` rows), 5 (software events, `stream.mark`, `engine.notice`), 7 (`engine.hello`, `commands.describe`, `daemon.status`), 10 (errors), 11 (versioning and frozen minimal surface); 0009 section 8 (`irreversible` in `commands.describe`); 0017 amendment to 0005 (config reload command); 0005 amendments of 2026-10-12 (`office.init` and `office.purge` as contract commands, provisional commands under section 11, reads in `commands.describe`); 0006 decision 5 (`daemon.status` fields) and the M0 review fix that reports resolved tool paths there (DIPO-15).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-19/define-contract-envelope-ids-errors"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(contract) example fixtures for every frame, command, read and event parse; malformed fixtures (unknown `kind`, `auth` with both code and token) fail."
    - kind: "automated"
      check: "(contract) committed JSON Schema files equal the export."
    - kind: "automated"
      check: "(unit) frozen-surface test."
    - kind: "automated"
      check: "(contract) a `commands.describe` fixture with a read entry parses; `office.purge` is marked `confirm` and `irreversible`; a definition with neither `since` nor `provisional` fails the definition test."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Branded id schemas for `OfficeId`, `StoryId`, `StoryKey`, `RunId`, `AgentId`, `RoleId`, `GateId`, `QuestionId`, `TestId`, `RequestId` and `Cursor` match the formats in 0005 section 2.
- [x] #2 `ClientFrame` and `ServerFrame` are discriminated unions exactly as 0005 section 3, including the `auth` refinement (exactly one of `code` or `token`).
- [x] #3 `EngineError` and every generic error code of 0005 section 10 are exported, with `retryable` true only for `engine.recovering`, `scheduling.off` and `run.hostAlive`.
- [x] #4 Schemas exist for the args and results of `office.open`, `office.forget`, `office.init`, `office.purge`, `office.rescan`, `office.reloadConfig`, `daemon.stop`, `daemon.setLogLevel`, `daemon.resumeScheduling`, and the reads `engine.hello`, `commands.describe` and `daemon.status`; `daemon.status` carries the absolute paths of `claude`, `backlog`, `gh`, `rg` and `git` the daemon resolved, each possibly missing.
- [x] #5 The `commands.describe` result lists commands and reads: each entry has a name, JSON Schema args and result and `since`; commands also carry `confirm` and `irreversible`, and `office.purge` is defined with `confirm: true` and `irreversible: true`.
- [x] #6 Every command and read definition in the contract carries either `since` (contract minor) or `provisional: true`, and a test fails on a definition with neither.
- [x] #7 Event data schemas exist for `office.registered`, `office.forgotten`, `office.summary`, `daemon.state`, `scan.finished`, `engine.notice` and `stream.mark`.
- [x] #8 `CONTRACT_VERSION` exports `{ major: 1, minor: 0 }`, and a test lists the frozen minimal surface of 0005 section 11 and fails when one of its fields changes.
- [x] #9 `bun run contract:schema` writes JSON Schema files under `packages/contract/schema/` with `z.toJSONSchema`, and a contract test fails when the committed files differ from a fresh export.
- [x] #10 `packages/contract` has no I/O and no dependency other than zod.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S04 (DIPO-15). Before cutover: built by hand-run agents.

Implemented (DIPO-19 branch):
- packages/contract/src: ids.ts, version.ts, errors.ts, envelope.ts (requests, replies, Event, ClientFrame, ServerFrame, subscribe and auth results), definition.ts (defineCommand/defineRead/defineEvent, checkVersioning, describeCommand/describeRead, jsonSchemaOf), software.ts (office.*, daemon.* commands, engine.hello, commands.describe, daemon.status reads, software events), catalog.ts (contractCommands/Reads/Events, describeContract, contractJsonSchemas). DIPO-20 appends its definitions to catalog.ts.
- Command, read and event names stay open dotted strings in the envelope, so an unknown name parses and the engine answers it with an error.
- since vs provisional: office.open, office.forget, office.rescan, daemon.stop, daemon.setLogLevel, daemon.resumeScheduling and the three reads have since 0 (contract 1.0, shapes fixed by 0005). office.init, office.purge and office.reloadConfig are provisional: 0005 does not fix their results, so DIPO-36, DIPO-76 and DIPO-27 set since when they ship. describeContract leaves provisional entries out, so describe entries always carry since.
- commands.describe entries also carry level (software or office), so clients know whether to fill the envelope office. Additive.
- daemon.status.tools holds the resolved absolute paths of claude, backlog, gh, rg and git; a tool not found is absent.
- DaemonState and OfficeSummary (0005 fields only) live here because software reads and events need them; DIPO-20 adds the 0009 OfficeSummary fields.
- JSON Schema is always the input side of zod: the output side adds additionalProperties false, which would make other-language readers reject fields a newer minor adds.
- I/O lives outside src: packages/contract/scripts/write-schema.ts (bun run contract:schema, then oxfmt), scripts/schema.test.ts (drift check, compares parsed JSON), scripts/boundary.test.ts (src imports only zod, no I/O globals; package depends on zod only). The contract tsconfig now includes scripts (rootDir .).
<!-- SECTION:NOTES:END -->
