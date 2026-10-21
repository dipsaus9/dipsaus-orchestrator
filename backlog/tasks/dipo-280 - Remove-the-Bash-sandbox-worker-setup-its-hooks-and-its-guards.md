---
id: DIPO-280
title: 'Remove the Bash-sandbox worker setup, its hooks and its guards'
status: Refined
assignee: []
created_date: '2026-10-21 13:45'
updated_date: '2026-10-21 14:35'
labels:
  - 'tier:M'
  - cutover
  - box
milestone: m-1
dependencies:
  - DIPO-275
  - DIPO-276
  - DIPO-279
  - DIPO-284
references:
  - packages/engine/src/workers/claude-cli/plan.ts
  - packages/engine/src/hooks/
  - packages/daemon/src/hook.ts
  - packages/engine/test/hooks/
  - packages/engine/test/workers/
priority: high
type: feature
ordinal: 269000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: once workers run in boxes, the old worker setup goes: the Bash sandbox settings, the permission rules and relay, the Bash hook with its gh and temp guards, and the self-test approval probe.

Context: Decision 0021 (worker isolation, DIPO-263) and the probe results of DIPO-264 (tools/box-probe/RESULTS.md and the 0021 amendment of 2026-10-21).

```dipo
branch: "DIPO-280/remove-old-sandbox"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 plan.ts no longer writes the Bash sandbox settings, permission rules or hooks for a worker
- [ ] #2 The Bash hook, the gh and temp guards and the permission relay are removed with their tests
- [ ] #3 Every test still passes, and nothing in the worker path refers to the removed parts
<!-- AC:END -->
