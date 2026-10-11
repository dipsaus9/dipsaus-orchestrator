---
id: DIPO-19
title: 'Define the contract envelope, ids, errors and software-level messages'
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-11 18:49'
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
  - docs/decisions/0009-tui.md
  - docs/decisions/0017-testing-strategy-and-configuration.md
priority: high
type: feature
ordinal: 19000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `packages/contract` holds the zod schemas for ids, frames, command and read envelopes, errors, cursors, contract versioning and the software-level commands, reads and events, with a JSON Schema export checked by a contract test.

Context: the work model (stories, runs, views) follows in DIPO-20 so each story stays reviewable. References: 0005 sections 2 (ids), 3 (envelopes and frames), 4 (`office.*`, `daemon.*` rows), 5 (software events, `stream.mark`, `engine.notice`), 7 (`engine.hello`, `commands.describe`, `daemon.status`), 10 (errors), 11 (versioning and frozen minimal surface); 0009 section 8 (`irreversible` in `commands.describe`); 0017 amendment to 0005 (config reload command).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

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
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Branded id schemas for `OfficeId`, `StoryId`, `StoryKey`, `RunId`, `AgentId`, `RoleId`, `GateId`, `QuestionId`, `TestId`, `RequestId` and `Cursor` match the formats in 0005 section 2.
- [ ] #2 `ClientFrame` and `ServerFrame` are discriminated unions exactly as 0005 section 3, including the `auth` refinement (exactly one of `code` or `token`).
- [ ] #3 `EngineError` and every generic error code of 0005 section 10 are exported, with `retryable` true only for `engine.recovering`, `scheduling.off` and `run.hostAlive`.
- [ ] #4 Schemas exist for the args and results of `office.open`, `office.forget`, `office.rescan`, `office.reloadConfig`, `daemon.stop`, `daemon.setLogLevel`, `daemon.resumeScheduling`, and the reads `engine.hello`, `commands.describe` (with `confirm`, `irreversible`, `since`), `daemon.status`.
- [ ] #5 Event data schemas exist for `office.registered`, `office.forgotten`, `office.summary`, `daemon.state`, `scan.finished`, `engine.notice` and `stream.mark`.
- [ ] #6 `CONTRACT_VERSION` exports `{ major: 1, minor: 0 }`, and a test lists the frozen minimal surface of 0005 section 11 and fails when one of its fields changes.
- [ ] #7 `bun run contract:schema` writes JSON Schema files under `packages/contract/schema/` with `z.toJSONSchema`, and a contract test fails when the committed files differ from a fresh export.
- [ ] #8 `packages/contract` has no I/O and no dependency other than zod.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S04 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
