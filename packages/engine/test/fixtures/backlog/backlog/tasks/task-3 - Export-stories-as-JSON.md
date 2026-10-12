---
id: TASK-3
title: Export stories as JSON
status: Parked
assignee: []
created_date: '2026-10-12 11:28'
labels:
  - 'tier:M'
dependencies: []
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: tools can read the story list as JSON.

```dipo
branch: "TASK-3/export-stories-as-json"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the JSON output parses and lists every story"
park: { reason: "on-hold", from: "Ready", note: "Waiting for the CSV export to land first" }
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The export command writes valid JSON
<!-- AC:END -->
