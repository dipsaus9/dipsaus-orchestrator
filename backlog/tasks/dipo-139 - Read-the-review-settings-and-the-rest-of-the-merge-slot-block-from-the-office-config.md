---
id: DIPO-139
title: >-
  Read the review settings and the rest of the merge slot block from the office
  config
status: Done
assignee: []
created_date: '2026-10-17 12:51'
updated_date: '2026-10-18 11:29'
labels:
  - 'tier:S'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-133
references:
  - packages/engine/src/config/
  - packages/engine/schema/
  - packages/engine/scripts/write-schema.ts
  - packages/engine/test/config/
  - packages/engine/test/office/
  - packages/engine/test/merge-slot/slot.test.ts
priority: high
type: feature
ordinal: 128000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the office config carries the review block (model, effort, maxRounds, maxTurns, maxMinutes, budgetTokens) and the mergeSlot keys autoMerge, conflictAttempts, ciAttempts, holdLabels and checksWaitMinutes, with their defaults, so the review loop stories read their limits from configuration.

Context: implements ADR 0019 section 16 (configuration), with the defaults decided in sections 2, 4, 6, 7, 8 and 10. The office config version order is DIPO-133 (mergeSlot.requiredChecks), then this story, then DIPO-164 (worker.web) and DIPO-165 (scope.packages, scope.restricted), then DIPO-116; each takes the next version with its in-memory migration (0017 amendment of 2026-10-12).

```dipo
branch: "DIPO-139/review-and-merge-slot-config"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the config migration from DIPO-133's version adds the review block and the new mergeSlot keys with their defaults"
    - kind: "automated"
      check: "(unit) validation refuses maxRounds 0, ciAttempts 0 and a duplicate hold label, naming the key"
park:
  reason: "ambiguous-spec"
  from: "In Progress"
  note: "May I add packages/engine/test/merge-slot/slot.test.ts to the scope? The fix is to write `mergeSlot: { ...OFFICE_DEFAULTS.mergeSlot, requiredChecks: [\"build\"] }` (and `[\"build\", \"pr-title\"]`) at lines 171 and 190, so tsc -b passes. Without it, verify fails on those two lines."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The office config accepts a review block with model (default opus), effort (default high), maxRounds (3), maxTurns (60), maxMinutes (30) and budgetTokens (200000), in the next config version after DIPO-133's, with its in-memory migration
- [x] #2 The mergeSlot block gains autoMerge (true), conflictAttempts (2), ciAttempts (2), holdLabels (empty list) and checksWaitMinutes (30); validation refuses a count below 1 and a duplicate hold label, naming the key
- [x] #3 packages/engine/schema/office.schema.json is rewritten by bun packages/engine/scripts/write-schema.ts, the config and office tests that pin the version are updated, and an office without the new keys gets the defaults
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M57BPT944P5D12KJAVH0ZA3H (Haiku low, 55 turns, about $0.11, 5 min) did the work and parked blocked with a scope question: packages/engine/test/merge-slot/slot.test.ts builds a partial mergeSlot, which no longer typechecks once the block has the new required fields. Office config version 5 (criterion 1 said the version after DIPO-133's; DIPO-172 took 4 meanwhile), identity migration from 4, KEY_ADDED_IN hints for review and the five mergeSlot keys. The defaults match 0019 section 16. office.local.yaml gains no key.

Finished outside the sandbox: the worker's uncommitted diff was copied onto DIPO-139/review-and-merge-slot-config-finish (origin/main merged in), and the two test lines now spread OFFICE_DEFAULTS.mergeSlot. packages/engine/test/merge-slot/slot.test.ts was added to the References. After review, table-driven tests cover every new count below 1 and every new mergeSlot key's version hint (mutation-checked). Verify: 3323 pass, 2 skip, 0 fail. Review passed.
<!-- SECTION:NOTES:END -->
