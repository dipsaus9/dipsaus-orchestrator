---
id: DIPO-510
title: Wrap a long message in the ticker under the body
status: In Review
assignee: []
created_date: '2026-11-13 10:15'
updated_date: '2026-11-17 14:56'
labels:
  - 'tier:S'
  - 'role:developer'
milestone: m-6
dependencies: []
references:
  - packages/tui/src/frame.tsx
  - packages/tui/src/actions.ts
  - packages/tui/src/screen.tsx
  - packages/tui/src/format.ts
  - packages/tui/src/app.test.tsx
type: bug
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want a long message in the line under the body, such as why an approve was refused, to wrap onto more rows so that I can read all of it.

The ticker under the body shows the latest message, refusal, failure, run summary or notice (packages/tui/src/screen.tsx:172-178). A refused action sets it to label: code: message (packages/tui/src/actions.ts:637). The Frame draws it as one dim Text with truncate-end (packages/tui/src/frame.tsx:117-121), and frameRows counts it as one row (frame.tsx:24-26, used at screen.tsx:188), so a long reason is cut at the right edge.

- The Frame wraps the ticker at word boundaries with wrapWords (packages/tui/src/format.ts:94) to the frame width, at most three rows; past three rows, the third ends with an ellipsis.
- frameRows takes the number of ticker rows, and screen.tsx passes the rows the wrapped ticker will take, so the body shrinks to fit.

## What it does not do
- Does not add a way to scroll or expand a message longer than three rows.
- Does not change which message the ticker picks.

## ADR lines that change
None.

## Risks and choices
- other: The three-row cap is my choice: enough for a refusal's reason without pushing the body off a small terminal.

```dipo
branch: "DIPO-510/wrap-long-message-ticker-under-body"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "frameRows counts one, two and three ticker rows, and the body height drops by the extra rows"
    - kind: "automated"
      check: "A 200-character refusal at 80 columns renders on three rows with no cut word, and a 400-character one ends its third row with an ellipsis"
    - kind: "automated"
      check: "A short ticker message renders on one row and leaves the body height as before"
    - kind: "automated"
      check: "A refused approve with a long error shows its code and the whole message in the rendered screen"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A ticker message longer than the frame width wraps at word boundaries onto as many rows as it needs, up to three.
- [x] #2 A ticker message that needs more than three rows shows three rows, and the third ends with an ellipsis.
- [x] #3 The body's height shrinks by each extra ticker row, so the screen never takes more rows than the terminal has.
- [x] #4 A ticker message that fits the width shows as one row, as before.
- [x] #5 A refused approve whose error message is longer than the width shows its whole code and message in the ticker.
<!-- AC:END -->
