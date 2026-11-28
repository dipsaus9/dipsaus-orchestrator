---
id: DIPO-520
title: >-
  TUI: hold every screen to its mock cell for cell, with roles, bold, underline
  and focus
status: Done
assignee: []
created_date: '2026-11-28 14:11'
updated_date: '2026-11-28 18:14'
labels:
  - 'tier:M'
  - 'role:developer'
milestone: m-6
dependencies: []
references:
  - packages/tui/test/support/mock-screens.ts
  - packages/tui/test/support/harness.ts
  - packages/tui/src/colour.tsx
  - packages/tui/src/overview.test.tsx
  - packages/tui/src/queue.test.tsx
  - packages/tui/src/planning.test.tsx
  - docs/design/tui-v2/spec.md
  - docs/design/tui-v2/roles.json
  - docs/design/chat-and-activity/spec.md
modified_files:
  - docs/design/tui-v2/screens/05-queue.txt
  - packages/tui/src/overview.test.tsx
  - packages/tui/src/planning.test.tsx
  - packages/tui/src/queue.test.tsx
  - packages/tui/test/support/harness.ts
  - packages/tui/test/support/mock-screens.test.ts
  - packages/tui/test/support/mock-screens.ts
priority: high
type: feature
ordinal: 481000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want a test to fail whenever a screen differs from its mock in any cell, colour or style, so that dipo's builders can make the TUI match the design exactly and I don't find the differences by eye.

Today `mockRows` strips `[role]`, `**` and `__` and the three tests that use it (Floor body, Queue list, Plan rows) compare text only, so roles, bold, underline, the sel background, the header, the rooms row, the ticker and the footer are never checked. That is how the footers, the ⏎ hints without a space, two unfaded rules and the plain underline shipped.

Build: `mockCells(file, title?)` parses a mock (any caption in a file, `tui-v2/screens/` or `chat-and-activity/screens/`) into a grid of cells `{ ch, role, bold, underline, sel }` following tui-v2 spec.md "Reading the screen files" (unmarked │ and full-width ─ are faint; `__x__` is underlined in the text's own colour). `frameCells(raw)` reads the harness's raw ANSI frame (`FakeTerminal.raw()`) into the same grid, mapping SGR back to roles through colour.tsx's ANSI table for the dark tone. `expectScreen(rendered, file, title)` compares the two and on failure prints each differing cell as `row:col expected <ch role style> got <ch role style>` plus both rows. Fixtures: one `OfficeSnapshot` (and chain, gate, output) per mock that reproduces its data, in `test/support/mock-fixtures.ts`. A guard test lists every caption in both screens folders and fails when one has no `expectScreen` call, unless the caption is listed in `KNOWN_GAPS` with the story that closes it.

The mock wins over the code. Where the code is right and the mock is wrong, the fix is a change to the mock in the same PR, named in the PR body.

```dipo
branch: "DIPO-520/screens-cell-for-cell"
unknowns:
  - q: "Whether Ink can underline in acc while the text is hi (needs SGR 58 for the underline colour)"
    status: "resolved"
    answer: "No SGR 58: the underline takes the text's own colour, and the reading rule of the mocks says so (maintainer, planning session of 2026-11-28; tui-v2 spec.md and roles.json changed in the backlog PR that filed this story). frameCells reads the underline's colour as the text's."
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) mockCells reads [role], nested roles, **bold**, __underline__ and [sel] of 02-floor.txt row 6 into the right cells"
    - kind: "automated"
      check: "(unit) frameCells maps the SGR of every role in colour.tsx back to its role, faint included, and the sel background"
    - kind: "automated"
      check: "(unit) expectScreen reports a single wrong role at row:col"
    - kind: "automated"
      check: "(unit) the guard fails for a caption with no expectScreen call and passes when it is in KNOWN_GAPS"
    - kind: "automated"
      check: "(integration) 02-floor.txt, 05-queue.txt and 07-plan.txt are held whole, header to footer, with the gaps they have today listed in KNOWN_GAPS"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 mockCells parses every caption of tui-v2/screens and chat-and-activity/screens into cells with role, bold, underline and sel, per tui-v2 spec.md "Reading the screen files"
- [x] #2 frameCells reads the rendered ANSI frame into the same cells through colour.tsx's ANSI table
- [x] #3 expectScreen compares whole frames, header, rooms, rules, ticker and footer included, and names each differing cell
- [x] #4 Every caption in both folders has an expectScreen test or a KNOWN_GAPS entry naming the story that closes it; the guard test enforces this
- [x] #5 The Floor, Queue and Plan tests use expectScreen on the whole frame instead of mockRows on part of it
- [x] #6 bun run verify runs all of it and stays under the local 60-second budget
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-28 18:14 UTC
- Criteria met: 6 of 6 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 1, failed 0
- Budget used: 126,766 of 800,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 0
<!-- SECTION:FINAL_SUMMARY:END -->
