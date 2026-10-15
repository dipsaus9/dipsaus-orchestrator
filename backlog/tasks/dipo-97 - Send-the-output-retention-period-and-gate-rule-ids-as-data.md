---
id: DIPO-97
title: Send the output retention period and gate rule ids as data
status: To Do
assignee: []
created_date: '2026-10-15 16:49'
labels:
  - 'tier:S'
milestone: m-0
dependencies: []
references:
  - packages/tui/src/past.ts
  - packages/tui/src/overview.tsx
  - packages/tui/src/format.ts
  - packages/contract/src/
  - packages/engine/src/gate/rules.ts
priority: medium
type: feature
ordinal: 87000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the TUI says output was removed after the retention period using the office setting, and shows Ready gate rule ids from a field, not from parsing message text.

Context: the TUI hard-codes a 7-day period (OUTPUT_RETENTION_DAYS, packages/tui/src/past.ts:10-11, used at 67-76) because the office retention period is not in the contract, as its comment says. The overview and queue parse rule ids like R15 from the gate message text (packages/tui/src/overview.tsx:124-127, packages/tui/src/format.ts:100-106), flagged as advisory in the DIPO-81 review.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The office view (or summary) carries the stored-output retention period in days, and the TUI uses it for the removed-output line.
- [ ] #2 Ready gate failures carry their rule id as a field next to the message, and the TUI uses the field; the text parsing is removed.
- [ ] #3 Both are minor contract additions with updated schema, fixtures and tests.
<!-- AC:END -->
