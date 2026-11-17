---
id: DIPO-509
title: Wrap long open and shell lines in the test overlay
status: Done
assignee: []
created_date: '2026-11-10 14:23'
updated_date: '2026-11-17 14:58'
labels:
  - 'tier:S'
  - 'role:developer'
milestone: m-6
dependencies: []
references:
  - packages/tui/src/checklist.tsx
  - packages/tui/src/checklist.test.tsx
  - packages/tui/src/format.ts
modified_files:
  - packages/tui/src/checklist.test.tsx
  - packages/tui/src/checklist.tsx
type: bug
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want a long open or shell line in the test overlay to wrap onto more rows so that I can read every character of a URL or command before I open or run it.

checklistLines builds the open line (packages/tui/src/checklist.tsx:85-91) and the shell line (:92-94) as one row each, and Checklist cuts every line to TEST_INNER with fitLine (:155). The tail of a long URL or command, and its o opens or c copies hint, disappear with no mark. The step text already wraps with wrapWords (:103-105; packages/tui/src/format.ts:94), which slices a word longer than the width, so a URL without spaces is split over rows, not lost.

- The URL and the command wrap with wrapWords to the room right of their label; the continuation rows are indented under the value.
- The hint stays on the last row when it fits there, else it takes a row of its own.
- o and c still act on the whole value.

## What it does not do
- Does not add horizontal scrolling to the overlay.
- Does not change how the step text wraps.

## ADR lines that change
None.

## Risks and choices
None.

```dipo
branch: "DIPO-509/wrap-long-open-shell-lines-test-overlay"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "The overlay of a test with a 150-character URL and a 150-character shell command holds every character of both, each over two or more rows"
    - kind: "automated"
      check: "The wrapped open and shell lines keep their o opens and c copies hints"
    - kind: "automated"
      check: "A short URL and a short shell command each render as one row, unchanged"
    - kind: "automated"
      check: "c on a test with a wrapped shell line copies the whole command"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 An open line whose URL is longer than the overlay's inner width shows every character of the URL over two or more rows.
- [x] #2 A shell line whose command is longer than the overlay's inner width shows every character of the command over two or more rows.
- [x] #3 The o opens and c copies hints still show for a wrapped open or shell line.
- [x] #4 An open or shell line that fits renders as one row, as before.
- [x] #5 c copies the whole command of a wrapped shell line.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-17 14:58 UTC
- Criteria met: 5 of 5 (as the worker reported them)
- Loops: 1; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 1, failed 0
- Budget used: 57,885 of 300,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 1
<!-- SECTION:FINAL_SUMMARY:END -->
