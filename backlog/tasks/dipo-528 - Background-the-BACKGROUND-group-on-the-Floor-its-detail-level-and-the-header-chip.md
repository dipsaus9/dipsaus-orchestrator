---
id: DIPO-528
title: >-
  Background: the BACKGROUND group on the Floor, its detail level and the header
  chip
status: In Review
assignee: []
created_date: '2026-11-28 14:11'
updated_date: '2026-11-28 19:49'
labels:
  - 'tier:M'
  - 'role:developer'
milestone: m-6
dependencies:
  - DIPO-520
  - DIPO-527
references:
  - packages/tui/src/overview.tsx
  - packages/tui/src/views.tsx
  - packages/tui/src/frame.tsx
  - docs/design/chat-and-activity/screens/03-floor-background.txt
  - docs/design/chat-and-activity/screens/04-background-detail.txt
  - docs/design/chat-and-activity/screens/07-states.txt
priority: high
type: feature
ordinal: 489000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want to see which PRs, CI runs, tests and audits are going and which broke, and open the one that broke, so that I know what happens behind the runs.

P5, TUI side. The BACKLOG row becomes the BACKGROUND group (03-floor-background.txt), rows from OfficeSnapshot.background as given. ⏎ opens an item at the Run's level (04-background-detail.txt for a PR; the lane's list, the test's steps and the audit's ideas for the others). The header gets the chip: `◌ N in background` or `✗ N failed in background`, absent when empty, clickable to the group. Ticker events from background.changed with their times.

Design: docs/design/chat-and-activity/ (screens/03-floor-background.txt, 04-background-detail.txt, 07-states.txt C6). The mocks win; a cell difference is a bug (DIPO-520).

```dipo
branch: "DIPO-528/background-floor"
unknowns:
  - q: "04-background-detail.txt shows a story PR's checks (format, lint, typecheck, `test (bun 1.4)` and so on, each with a state) and the failed check's log tail with the failing line. `BackgroundItem` and the other reads carry none of this: only `ci` as one state, a subject and a `next` line. May I add an engine read, for example `background.detail`, that returns a PR's checks and log tail (the contract schema, an engine implementation that fetches them through gh, and the TUI level)? Or should the level be built later, when the engine side exists, and this story close on the group, chip and ticker?"
    status: "resolved"
    answer: "Build the level later. Close this story on the BACKGROUND group, the header chip, the ticker, and ⏎ for the backlog PR, test and audit kinds. For a story PR, ⏎ opens the PR (o) until the checks read exists. 04-background-detail.txt is not part of this story's expectScreen; a follow-up story adds the engine read for a PR's checks, log tail and attempt history, and that screen."
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
- [x] #1 The Floor shows BACKGROUND from the snapshot in its order, replacing the BACKLOG row
- [x] #2 ⏎ opens the item's level as the mocks show
- [x] #3 The header chip follows 07-states.txt C6
- [x] #4 The two screens pass expectScreen
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parked 2026-11-28 19:10 UTC: ambiguous-spec
- Detail: 04-background-detail.txt shows a story PR's checks (format, lint, typecheck, `test (bun 1.4)` and so on, each with a state) and the failed check's log tail with the failing line. `BackgroundItem` and…
- Run: run_01M8HRE9YDTY7FS4VN54WEVWD2
- Criteria met: 2 of 4 (as the worker reported them)
- Loops: 0 of 5; CI attempts: 0 of 2
- Review rounds: 0, failed 0 of 3
- Budget used: 225,776 of 800,000 tokens; 85 of 200 turns; 10 of 90 minutes
- Last good commit: 4ce62924247e8dee6e4ce39cd0dc04421a0d009c

Resumed 2026-11-28 19:38 UTC; grants: none; note: Build the level later. Close this story on the BACKGROUND group, the header chip, the ticker, and ⏎ for the backlog PR, test and audit kinds. For a story PR, ⏎ opens the PR (o) until the checks read…
<!-- SECTION:NOTES:END -->
