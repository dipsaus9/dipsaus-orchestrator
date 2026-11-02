---
id: DIPO-430
title: 'Keep a blocked worker''s question on its park, also across a restart'
status: Ready
assignee: []
created_date: '2026-11-02 13:23'
updated_date: '2026-11-02 13:33'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/run/outcome-exits.ts
  - packages/engine/src/run/park.ts
  - packages/engine/src/run/control-types.ts
  - packages/engine/src/run/control-endings.ts
  - packages/engine/src/overview/desk.ts
  - packages/contract/src/office.ts
  - packages/contract/schema/
  - packages/contract/test/fixtures.ts
  - packages/cli/src/answer-command.ts
  - packages/cli/src/desk-command.test.ts
  - packages/tui/src/desk.test.tsx
  - packages/engine/test/run/
  - packages/engine/test/questions/
  - packages/engine/test/overview/
priority: medium
type: bug
ordinal: 408000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: every park that comes from a blocked worker report shows the worker's question on the desk, so the maintainer always has something to answer, even when the daemon restarted between the decision and the park.

Found by the review of DIPO-428 (PR #565) on 2026-11-02. In packages/engine/src/run/outcome-exits.ts (about line 233) a park from a blocked result decided at exit passes `report` but not `report.question`, so that park carries no question. The question text is also not part of the park intent, so a daemon restart between the intent and the park can leave a park with nothing to answer. The no-TUI path had the same gap before DIPO-428; since DIPO-428 every question goes through it. The review also found text left from the live route: packages/engine/src/run/control-types.ts (about lines 194-196, "when no open question carries over ... with no TUI connected"), the desk's group 1 label "· worker waiting" for an unparked question (packages/engine/src/overview/desk.ts), and the contract's `delivered: "now"` (packages/contract/src/office.ts about line 95), which nothing produces any more.

Design: the question text goes into the park intent's existing detail (`intentDetail`, control-types.ts about line 188, written in control-endings.ts about line 496, under its own tag as other intent details are), and the park reads it back from there, so the park asks it whether it is written at once or after a restart; no new column or migration. The stale texts go. Desk group 1 (open questions no park carries) keeps its place in 0020's desk order but loses the "· worker waiting" label, and its tests and fixtures change with it. `delivered: "now"` is removed from the contract (the CLI branches only on "on-resume", packages/cli/src/answer-command.ts), and `bun run contract:schema` regenerates packages/contract/schema/. One park path (0001). 0020.

```dipo
branch: "DIPO-430/park-keeps-question"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a park from a blocked result decided at exit carries the report's question, the park intent holds the question text so a restart before the park still asks it, and no stale live-question text remains"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A blocked result decided at exit parks with the report's question on the park, shown by a test
- [ ] #2 A daemon restart between the park intent and the park still gives a park that asks the question, shown by a test that stops after the intent
- [ ] #3 The live-route texts in control-types.ts and the desk's group 1 label are gone, and `delivered: "now"` is removed, shown by the diff and by `bun run contract:schema` leaving no change after it
<!-- AC:END -->
