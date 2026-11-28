---
id: DIPO-908
title: >-
  Background: the BACKGROUND group on the Floor, its detail level and the header chip
status: Draft
assignee: []
created_date: '2026-11-28 10:00'
labels:
  - 'tier:M'
  - 'role:developer'
milestone: m-6
dependencies:
  - DIPO-900
  - DIPO-907
references:
  - packages/tui/src/overview.tsx
  - packages/tui/src/views.tsx
  - packages/tui/src/frame.tsx
  - docs/design/chat-and-activity/screens/03-floor-background.txt
  - docs/design/chat-and-activity/screens/04-background-detail.txt
  - docs/design/chat-and-activity/screens/07-states.txt
priority: high
type: feature
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want to see which PRs, CI runs, tests and audits are going and which broke, and open the one that broke, so that I know what happens behind the runs.

P5, TUI side. The BACKLOG row becomes the BACKGROUND group (03-floor-background.txt), rows from OfficeSnapshot.background as given. ⏎ opens an item at the Run's level (04-background-detail.txt for a PR; the lane's list, the test's steps and the audit's ideas for the others). The header gets the chip: `◌ N in background` or `✗ N failed in background`, absent when empty, clickable to the group. Ticker events from background.changed with their times.

Design: docs/design/chat-and-activity/ (screens/03-floor-background.txt, 04-background-detail.txt, 07-states.txt C6). The mocks win; a cell difference is a bug (DIPO-900).

```dipo
branch: "DIPO-908/background-floor"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(integration) 03-floor-background.txt and 04-background-detail.txt pass expectScreen"
    - kind: "automated"
      check: "(unit) the header chip reads ◌ N, or ✗ N in err when one failed, and is absent with none"
    - kind: "automated"
      check: "(unit) a background.changed event shows in the ticker with its HH:MM"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The Floor shows BACKGROUND from the snapshot in its order, replacing the BACKLOG row
- [ ] #2 ⏎ opens the item's level as the mocks show
- [ ] #3 The header chip follows 07-states.txt C6
- [ ] #4 The two screens pass expectScreen
<!-- AC:END -->
