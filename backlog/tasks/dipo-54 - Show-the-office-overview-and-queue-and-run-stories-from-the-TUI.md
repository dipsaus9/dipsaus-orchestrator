---
id: DIPO-54
title: Show the office overview and queue and run stories from the TUI
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-14 13:54'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-52
  - DIPO-53
references:
  - packages/tui/src/
  - packages/tui/test/
  - packages/client/src/client.ts
  - packages/client/src/store/office-store.ts
  - packages/client/test/unit/client.test.ts
  - packages/client/test/unit/office-store.test.ts
documentation:
  - docs/decisions/0009-tui.md
priority: high
type: feature
ordinal: 54000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the TUI's overview view (`1`) shows who works on what with phase, health, criteria, loop, verify, budget share and time, and the queue view (`2`) lists stories by column with the first gate message for Refined stories, where `u` runs the selected or next Ready story.

Context: desk, testing and cost views are M1. References: 0009 sections 4 (overview and queue layouts), 5 (run key `u`, read-your-writes, error footer, retry with the same request id), 6 (keys), 9 (width breakpoints, memoised rows, 10 Hz batching).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-54/show-office-overview-queue-run-stories"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(TUI) overview frame from a golden log at 120 and 80 columns."
    - kind: "automated"
      check: "(TUI) `u` on a Ready row sends `work.run` with that story; a `dependency` skip is shown."
    - kind: "manual"
      check: "in a scratch office with one Ready story, open `dipo tui`, press `2`, select it and press `u`"
      expect: "the overview shows the story in phase `setup`, then `build`."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The overview lists each `WorkView` with story, role, tier, phase, health word and glyph, AC, loop, verify, budget bar with percentage, and elapsed time.
- [ ] #2 A summary line shows Ready, waiting and held counts.
- [ ] #3 The queue lists sections in column order with counts; `waiting` rows name the dependency; Refined rows show the first gate message with its rule id.
- [ ] #4 `u` sends `work.run` with the selected story, or none for the next Ready one, and shows started and skipped stories with reasons.
- [ ] #5 After a reply the action is marked done only when the stream passes the reply cursor; an error shows its message in the footer, and a retryable one offers Ctrl-R with the same request id.
- [ ] #6 Columns drop at the 0009 width breakpoints and nothing scrolls horizontally.
- [ ] #7 Events are applied in batches at most 10 times per second.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S38 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
