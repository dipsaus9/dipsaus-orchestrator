---
id: DIPO-6
title: Choose the TUI framework and interaction model
status: To Do
assignee: []
created_date: '2026-10-09 19:17'
labels:
  - architecture
milestone: m-0
dependencies:
  - DIPO-1
priority: high
type: spike
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an ADR choosing the TUI technology (constrained by DIPO-1) and defining the main views: queue by lifecycle state, live worker output, parked triage list, and testing checklist. The TUI is a thin client on the command and event model. Include how a web or desktop client could follow.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 ADR docs/decisions/0009-tui.md records options, choice and view sketches
- [ ] #2 ADR confirms the TUI uses only the public command and event interface
- [ ] #3 Maintainer approved the decision
<!-- AC:END -->
