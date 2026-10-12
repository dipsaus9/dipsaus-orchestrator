---
id: TASK-1
title: Add the CSV export command
status: Ready
assignee: []
created_date: '2026-10-12 11:28'
labels:
  - 'tier:S'
dependencies: []
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: maintainers can export the story list as CSV for a spreadsheet.

```dipo
branch: "TASK-1/add-the-csv-export-command"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) one CSV row per story, header first"
    - kind: "manual"
      check: "Run the export and open the file in a spreadsheet"
      expect: "Every story shows on its own row"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The export command writes one CSV row per story
- [ ] #2 A header row names every column
<!-- AC:END -->
