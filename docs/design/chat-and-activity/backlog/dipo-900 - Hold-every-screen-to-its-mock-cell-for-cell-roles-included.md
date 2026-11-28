---
id: DIPO-900
title: >-
  TUI: hold every screen to its mock cell for cell, with roles, bold, underline and focus
status: Draft
assignee: []
created_date: '2026-11-28 10:00'
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
priority: high
type: feature
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want a test to fail whenever a screen differs from its mock in any cell, colour or style, so that dipo's builders can make the TUI match the design exactly and I don't find the differences by eye.

Today `mockRows` strips `[role]`, `**` and `__` and the three tests that use it (Floor body, Queue list, Plan rows) compare text only, so roles, bold, underline, the sel background, the header, the rooms row, the ticker and the footer are never checked. That is how the footers, the ⏎ hints without a space, two unfaded rules and the plain underline shipped.

Build: `mockCells(file, title?)` parses a mock (any caption in a file, `tui-v2/screens/` or `chat-and-activity/screens/`) into a grid of cells `{ ch, role, bold, underline, sel }` following tui-v2 spec.md "Reading the screen files" (unmarked │ and full-width ─ are faint; `__x__` is underlined in acc). `frameCells(raw)` reads the harness's raw ANSI frame (`FakeTerminal.raw()`) into the same grid, mapping SGR back to roles through colour.tsx's ANSI table for the dark tone. `expectScreen(rendered, file, title)` compares the two and on failure prints each differing cell as `row:col expected <ch role style> got <ch role style>` plus both rows. Fixtures: one `OfficeSnapshot` (and chain, gate, output) per mock that reproduces its data, in `test/support/mock-fixtures.ts`. A guard test lists every caption in both screens folders and fails when one has no `expectScreen` call, unless the caption is listed in `KNOWN_GAPS` with the story that closes it.

The mock wins over the code. Where the code is right and the mock is wrong, the fix is a change to the mock in the same PR, named in the PR body.

```dipo
branch: "DIPO-900/screens-cell-for-cell"
unknowns:
  - q: "Whether Ink can underline in acc while the text is hi (needs SGR 58 for the underline colour); until decided, frameCells reads the underline's colour as the text's and KNOWN_GAPS lists the underlined captions"
    status: "open"
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
- [ ] #1 mockCells parses every caption of tui-v2/screens and chat-and-activity/screens into cells with role, bold, underline and sel, per tui-v2 spec.md "Reading the screen files"
- [ ] #2 frameCells reads the rendered ANSI frame into the same cells through colour.tsx's ANSI table
- [ ] #3 expectScreen compares whole frames, header, rooms, rules, ticker and footer included, and names each differing cell
- [ ] #4 Every caption in both folders has an expectScreen test or a KNOWN_GAPS entry naming the story that closes it; the guard test enforces this
- [ ] #5 The Floor, Queue and Plan tests use expectScreen on the whole frame instead of mockRows on part of it
- [ ] #6 bun run verify runs all of it and stays under the local 60-second budget
<!-- AC:END -->
