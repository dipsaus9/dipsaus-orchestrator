---
id: DIPO-20
title: 'Define the contract work model: lifecycle, views, work commands and events'
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 11:47'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-19
references:
  - packages/contract/
documentation:
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0009-tui.md
  - docs/decisions/0010-backlog-and-git-integration.md
  - docs/decisions/0012-story-standard.md
priority: high
type: feature
ordinal: 20000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the contract holds the story and work model (lifecycle, park reasons, tiers, views, usage, progress), the office-level commands, reads and events of contract 1.0 including the 0008 and 0009 minor additions, and the strict field-block schema shared with the engine.

Context: commands that M0 does not implement are still defined, because 0005 puts them in contract 1.0; they are provisional until they first ship with a `since` version, so renaming one is not a major change, and the engine hides them with capability flags (0005 amendment of 2026-10-12). `Tier`, `ParkReason` and `SkipReason` are open enums: the engine validates a tier against the office tier set, and clients render an unknown value generically (same amendment). References: 0005 sections 4 (work, story, gate, test commands, `SkipReason`), 5 (views, events, `WorkRef`), 7 (`office.snapshot`, `story.detail`, `work.outputRange`); 0008 amendments to 0005 (park reasons, `Usage.budget` in tokens, cache split, `QuestionView.kind`, `work.answer.decision`); 0009 sections 3 and 8 (phases, signals, `Health`, `Evidence`, `budgetShare`, `waitingOn`, `gateMessages`, `office.usage`, `office.digest`); 0010 section 3 (field block keys); 0012 F14, F16.

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-20/define-contract-work-model-lifecycle"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(contract) fixtures for every new command, read, event and view parse; an unknown health value, park reason, tier and skip reason each parse; an unknown lifecycle fails."
    - kind: "automated"
      check: "(contract) every command and read listed as provisional has no `since`, and every other one has `since` 1.0."
    - kind: "automated"
      check: "(contract) field block fixtures: valid block, unknown key, `answer: 5173`, `test_plan` with both `entries` and `not_applicable`."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `Lifecycle` and `DaemonState` are closed enums with the exact values of 0005 as amended; `Tier`, `ParkReason` (11 known values) and `SkipReason` are open enums whose known values are exported and whose schemas accept any other string (0005 amendment of 2026-10-12).
- [x] #2 `Phase` (`setup`, `build`, `verify`, `review`, `test`, `merge`), watchdog signals and `Health` (eight states) are open enums: unknown strings parse.
- [x] #3 `StoryView`, `WorkView`, `GateView`, `QuestionView`, `TestView`, `Progress`, `UsageTotals` (with `cacheCreateTokens` and `cacheReadTokens`) and `Usage` (budget unit `"tokens"`, `budgetShare`) match 0005 section 5 with the 0008 and 0009 additions.
- [x] #4 Args and results exist for `work.run`, `work.answer`, `work.steer`, `work.pause`, `work.resume`, `work.reassign`, `work.stop`, `work.discard`, `story.hold`, `story.drop`, `gate.approve`, `gate.reject`, `test.start`, `test.record`, and for the reads `office.snapshot`, `story.detail`, `work.outputRange`, `office.usage`, `office.digest`.
- [x] #5 Office event schemas exist for every office row of the 0005 section 5 event table.
- [x] #6 `FieldBlock` is a `z.strictObject` with `branch`, `unknowns`, `test_plan` and `park` as 0010 section 3; a non-string text value fails with a message containing `quote this value`.
- [x] #7 The JSON Schema export of DIPO-19 includes the new schemas and its contract test passes.
- [x] #8 The commands and reads M0 does not build are marked `provisional: true` with no `since`: `work.steer`, `work.pause`, `work.resume` (until DIPO-61 ships it for held runs), `work.reassign`, `work.discard`, `story.hold`, `story.drop`, `gate.approve`, `gate.reject`, `test.start`, `test.record`, `office.usage` and `office.digest`; every other command and read of this story carries `since` 1.0.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S05 (DIPO-15). Before cutover: built by hand-run agents.

Implementation (DIPO-20 branch):
- packages/contract/src/work.ts: Lifecycle (closed), open enums via openEnum() for Tier, ParkReason (11), SkipReason (7), Phase, Signal, Health (8), QueueColumn and GateKind with exported KNOWN_* values; Evidence; WorkRef, Progress, UsageTotals (cache split), Usage (budget unit tokens, budgetShare), StoryView (waitingOn, gateMessages, evidence), WorkView (signals, lastOutputAt, evidence), GateView, QuestionView (kind), TestView. DaemonState is reused from software.ts.
- packages/contract/src/office.ts: the 14 office commands, the 5 reads and the 15 office events of the 0005 section 5 table. Provisional per AC #8; work.run, work.answer, work.stop, office.snapshot, story.detail and work.outputRange carry since 0 (1.0).
- packages/contract/src/fieldblock.ts: FieldBlock strictObject; text values fail with 'expected a string: quote this value'; test_plan needs exactly one of entries or not_applicable; branch checked against the R18 pattern without the id equality (the gate owns that); presence and content rules stay with R15, R18, R20.
- OfficeSummary gains optional dayUsage and evidence (0009 section 8).
- JSON Schema export adds work.schema.json; regenerated with bun run contract:schema.
Choices to confirm: story.drop is confirm true but irreversible false (the static flag cannot depend on deleteBranch; clients ask typed confirmation when deleteBranch is true, 0009 section 5). work.answer keeps text required next to the optional decision. story.detail, office.usage and office.digest result shapes are a first cut for DIPO-52 and M1. office.switch (0005 section 7) is not defined here.
<!-- SECTION:NOTES:END -->
