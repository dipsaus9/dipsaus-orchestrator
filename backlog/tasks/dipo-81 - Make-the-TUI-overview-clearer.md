---
id: DIPO-81
title: Make the TUI overview clearer
status: To Do
assignee: []
created_date: '2026-10-14 15:29'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-54
  - DIPO-55
references:
  - packages/tui/src/
  - docs/decisions/0009-tui.md
priority: medium
type: feature
ordinal: 72000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the maintainer can tell at a glance what the office is doing and what each running story is doing now, from the TUI overview and the office switcher.

Context: maintainer feedback from the DIPO-54 hand test (2026-10-14): "Ready 0 was not visible, only in the overview, but not in the office. I find it a bit confusing on what is happening and the layout feels a bit odd." The live output itself is DIPO-55 ("If a process is running I want to be able to view what is happening"); this story makes the overview and switcher clearer around it.

The layout is a design decision the maintainer makes: the story starts with a short written proposal (text mock of the overview and switcher at 120 and 80 columns) that the maintainer approves before any code changes. If the proposal changes the 0009 mock, the 0009 amendment needs the maintainer's approval too.

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. The TUI stays a pure client of the contract. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP`.

```dipo
branch: "DIPO-81/make-tui-overview-clearer"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(tui) render tests of the approved overview and switcher layout at 120, 80 and 60 columns"
    - kind: "manual"
      check: "Run TASK-1 from the TUI on the scratch repo and watch the overview and the switcher"
      expect: "Ready, running and review counts match in both places, and each running story says what it is doing now in words"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A layout proposal (text mock of the overview and the office switcher at 120 and 80 columns) is approved by the maintainer before code changes
- [ ] #2 The office switcher shows the Ready count next to running, desk and held, matching the overview
- [ ] #3 Each running story's overview row says in words what it is doing now (for example the phase and the worker's last tool or step), not only codes and glyphs
- [ ] #4 The overview layout follows the approved proposal at every width tier, with [q] quit always visible
<!-- AC:END -->
