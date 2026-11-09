---
id: DIPO-462
title: 'TUI v2: the story reader and the test overlay'
status: In Progress
assignee: []
created_date: '2026-11-06 14:12'
updated_date: '2026-11-09 18:03'
labels:
  - 'tier:M'
milestone: m-6
dependencies:
  - DIPO-459
references:
  - packages/tui/src/story-card.tsx
  - packages/tui/src/checklist.tsx
  - packages/tui/src/detail.tsx
  - docs/design/tui-v2/spec.md
  - docs/design/tui-v2/screens/04-story-reader.txt
  - docs/design/tui-v2/screens/10-test-overlay.txt
  - docs/design/tui-v2/designs/dipo-ux-spec.html
  - packages/contract/src/office.ts
  - packages/engine/src/reads
priority: medium
type: feature
ordinal: 435000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want to read a story's reviews in full and run its manual test from the merge item, so that I judge from complete text and test without changing rooms.

Step 6. The story card gets Story, Criteria, Reviews, Runs and Diff sections (Diff needs an engine addition: a diff read for the story's branch) at a centred 84-column measure that wraps. The checklist leaves room 4 and becomes an overlay opened by t on a MERGE item, with y pass, n fail and c copying the shell line.

Design: docs/design/tui-v2/ (spec.md, screens/, keymap.json, roles.json, migration.md). The screens must match `docs/design/tui-v2/designs/dipo-ux-spec.html` exactly; the text mocks in `screens/` are the same screens in text. Where spec.md's Maintainer decisions (2026-11-06) differ from the HTML, the text files win.

```dipo
branch: "DIPO-462/tui-v2-reader-test"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) reader wraps long findings at 84 columns"
    - kind: "automated"
      check: "(unit) overlay pass and fail send test.record"
    - kind: "manual"
      check: "On a story waiting for its test, press t, tick two steps and fail with n"
      expect: "The note starts with the third step and the story gets a fix round"
    - kind: "manual"
      check: "Open a done story's Reviews section and a merge item's test overlay next to designs/dipo-ux-spec.html S4 and S1d"
      expect: "The reader and the overlay match the HTML preview side by side"
    - kind: "automated"
      check: "(unit) the diff read returns the story branch's diff and the Diff tab shows it"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The story reader wraps every criterion, finding and quote at an 84-column measure and truncates nothing
- [ ] #2 The latest review round is open and earlier rounds fold to one line
- [ ] #3 t on a MERGE item starts the test and opens the overlay; y passes, n fails with the first unticked step as the note
- [ ] #4 Esc hides the overlay and leaves the test open; a test.ended event says why it closed
- [ ] #5 The story reader and the test overlay match the HTML preview's S4 and S1d. The screens must match `docs/design/tui-v2/designs/dipo-ux-spec.html` exactly; the text mocks in `screens/` are the same screens in text
- [ ] #6 A diff read for the story's branch exists (engine addition) and the Diff tab shows it
<!-- AC:END -->
