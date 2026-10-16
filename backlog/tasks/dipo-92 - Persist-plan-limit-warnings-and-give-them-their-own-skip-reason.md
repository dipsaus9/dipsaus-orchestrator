---
id: DIPO-92
title: Persist plan-limit warnings and give them their own skip reason
status: Done
assignee: []
created_date: '2026-10-15 16:49'
updated_date: '2026-10-16 07:20'
labels:
  - 'tier:S'
milestone: m-0
dependencies:
  - DIPO-61
references:
  - packages/engine/src/run/plan-limit.ts
  - packages/engine/src/run/work-run.ts
  - packages/contract/src/work.ts
  - packages/engine/src/db/schema.ts
  - packages/engine/src/db/migrations/0026-plan-limit-warnings.ts
  - packages/engine/src/retention/policy.ts
  - packages/engine/test/run/plan-limit.test.ts
  - packages/engine/test/run/work-run.test.ts
  - packages/contract/src/work.test.ts
  - packages/tui/src/format.ts
  - packages/tui/src/format.test.ts
  - packages/cli/src/run-command.ts
  - packages/cli/src/run-command.test.ts
  - packages/contract/schema/commands.schema.json
  - packages/contract/schema/reads.schema.json
  - packages/contract/schema/work.schema.json
priority: medium
type: feature
ordinal: 82000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a plan-limit warning hold survives a daemon restart, and a story held by a plan limit is reported with a planLimit skip reason, not capacity.

Context: DIPO-61 left warnings in memory: an allowed_warning holds new runs on its scope until resetsAt or for an hour, but warnings live in memory and are lost on restart (packages/engine/src/run/plan-limit.ts:14-16, the #warnings map at 168). work.run reports a plan-limit hold with the capacity skip reason (packages/engine/src/run/work-run.ts:394), the same word as maxAgents or the office cap (packages/engine/src/run/work-run.ts:373; packages/contract/src/work.ts:65-74), so the TUI and CLI say the office is full when the plan is limited.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A warning hold is stored with its scope, adapter and until time and is armed again on office load; a hold whose time passed while the daemon was down is dropped.
- [x] #2 The contract adds the skip reason planLimit (a minor addition to the open enum), work.run uses it for plan-limit holds, and the TUI and dipo run explain it in words.
- [x] #3 Tests cover a warning before a restart that still holds after it, an expired one that does not, and the planLimit reason.
<!-- AC:END -->
