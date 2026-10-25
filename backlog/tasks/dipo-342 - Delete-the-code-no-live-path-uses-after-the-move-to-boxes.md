---
id: DIPO-342
title: Delete the code no live path uses after the move to boxes
status: Done
assignee: []
created_date: '2026-10-25 09:50'
updated_date: '2026-10-25 11:26'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:1'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/workers/claude-cli/
  - packages/engine/src/hooks/
  - packages/engine/src/prompts/
  - packages/engine/src/run/
  - packages/engine/src/worktree/base-verify.ts
  - packages/engine/src/db/
  - packages/contract/src/
  - packages/cli/src/
  - packages/tui/src/
priority: high
type: chore
ordinal: 322000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the code the move to boxes left without a caller is gone: the developer's Mac launch plan, the developer nudges, the implement prompt contract, the backstop leftovers, the never-written verify tables, the needs-permission report field, work.reassign and office.usage, and every test still passes.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. Pure deletion, no design change (audit section 4). Config keys and the pricing and scan tables wait for the v14 reset and the database cut.

```dipo
branch: "DIPO-342/delete-dead-code-after-boxes"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(lint, unit) bun run verify passes and the contract tests no longer list the removed commands, reads and fields"
    - kind: "automated"
      check: "(db) the migration drops base_verifies and verify_results, and a fresh database equals a migrated one"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The Mac developer parts of workers/claude-cli/plan.ts, the implement prompt contract and the developer nudge sources are removed; plan.ts keeps only what the reviewer and the scan session use
- [x] #2 run/backstop.ts keeps only what git-state resumes read, and storeBaseVerify, insertVerifyResult, base_verifies and verify_results are removed with a migration
- [x] #3 The needsPermission field of the worker report, work.reassign and office.usage are removed from the contract, engine, CLI and TUI; test.start, test.record, the test.started and test.recorded events and the TUI key t stay, because DIPO-309 makes them real
- [x] #4 A search of packages/ and scripts/ finds no reference to a removed name
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Deleted the code the move to boxes left without a caller: the Mac implement contract, the developer nudges and their sources, the backstop compare, the verify tables (base_verifies, verify_results) and nudge_sources with migration 56, the needsPermission report field, work.reassign and office.usage (+394 −3125 over 95 files). Kept until DIPO-347: the reviewer's budget nudge in hooks/nudges.ts and the reviewer's deny rules in plan.ts. The box developer's task message no longer has a base_verify section, which always read not known.
<!-- SECTION:FINAL_SUMMARY:END -->
