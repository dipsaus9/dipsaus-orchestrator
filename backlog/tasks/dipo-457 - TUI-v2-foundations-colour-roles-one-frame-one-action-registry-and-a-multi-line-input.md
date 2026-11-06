---
id: DIPO-457
title: >-
  TUI v2 foundations: colour roles, one frame, one action registry and a
  multi-line input
status: In Progress
assignee: []
created_date: '2026-11-06 14:11'
updated_date: '2026-11-06 15:46'
labels:
  - 'tier:M'
milestone: m-6
dependencies:
  - DIPO-443
references:
  - packages/tui/src/colour.tsx
  - packages/tui/src/screen.tsx
  - packages/tui/src/keys.ts
  - packages/tui/src/footer.ts
  - packages/tui/src/actions.ts
  - docs/design/tui-v2/spec.md
  - docs/design/tui-v2/keymap.json
  - docs/design/tui-v2/roles.json
  - docs/design/tui-v2/screens/17-themes.txt
  - docs/design/tui-v2/designs/dipo-ux-spec.html
  - packages/tui/src/planning.tsx
modified_files:
  - packages/cli/src/tui-command.ts
  - packages/tui/src/app.test.tsx
  - packages/tui/src/colour.test.ts
  - packages/tui/src/colour.tsx
  - packages/tui/src/composer.test.tsx
  - packages/tui/src/composer.tsx
  - packages/tui/src/desk.test.tsx
  - packages/tui/src/desk.tsx
  - packages/tui/src/detail.test.tsx
  - packages/tui/src/detail.tsx
  - packages/tui/src/footer.test.ts
  - packages/tui/src/footer.ts
  - packages/tui/src/frame.tsx
  - packages/tui/src/home.tsx
  - packages/tui/src/index.ts
  - packages/tui/src/keys.ts
  - packages/tui/src/live.test.tsx
  - packages/tui/src/options.ts
  - packages/tui/src/overview.test.tsx
  - packages/tui/src/overview.tsx
  - packages/tui/src/planning.test.tsx
  - packages/tui/src/planning.tsx
  - packages/tui/src/queue.test.tsx
  - packages/tui/src/queue.tsx
  - packages/tui/src/run.tsx
  - packages/tui/src/screen.tsx
  - packages/tui/src/settings.tsx
  - packages/tui/src/theme.test.ts
  - packages/tui/src/theme.ts
  - packages/tui/src/views.tsx
priority: medium
type: feature
ordinal: 430000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want every TUI screen drawn in one frame with colour roles and every key coming from one registry, so that keys stay consistent and later views land in the new design by construction.

Step 1 of docs/design/tui-v2/migration.md. Colored takes one of the ten roles of roles.json (the nine of the ux-spec plus shade for overlay backdrops), with per-theme values exactly as the HTML previews, instead of a raw colour, with the truecolor Classical theme opt-in and theme detection by OSC 11, then COLORFGBG, then dark. A Frame component owns header, rooms, body, ticker and keys. KEY_TABLE grows label, when() and priority, and the footer reads hints from it. A Composer component gives a multi-line input (Enter adds a line, ctrl-s sends, Esc cancels) that replaces the planning view's own input (DIPO-449), so one input remains. Below 60 columns or 16 rows the Frame shows "Widen the terminal to at least 60 columns". Screens look the same apart from colours.

Design: docs/design/tui-v2/ (spec.md, screens/, keymap.json, roles.json, migration.md). The screens must match `docs/design/tui-v2/designs/dipo-ux-spec.html` exactly; the text mocks in `screens/` are the same screens in text. Where spec.md's Maintainer decisions (2026-11-06) differ from the HTML, the text files win.

```dipo
branch: "DIPO-457/tui-v2-foundations"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) colour roles map to ANSI slots and drop under NO_COLOR"
    - kind: "automated"
      check: "(unit) footer hints come from the registry and fit the width with q quit kept"
    - kind: "automated"
      check: "(unit) Composer adds a line on Enter and sends on ctrl-s"
    - kind: "manual"
      check: "Open the TUI in a dark and a light terminal, once with NO_COLOR=1, next to designs/dipo-ux-spec.html S10 (Tweaks: dark/light, truecolor/ansi16)"
      expect: "Each terminal matches the HTML preview side by side: same roles, the focus row on sel, and under NO_COLOR only ▌ marks it"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Colored takes a role from the ten roles in roles.json (bg, fg, hi, dim, faint, acc, ok, err, sel, shade) and maps each to its ANSI slot and per-theme values; hi is a brighter colour and bold appears only where a screen marks it; dim and faint stay distinct; NO_COLOR makes sel equal bg so only ▌ marks the focused row, and NO_COLOR and --ascii still read fully
- [x] #2 One Frame component draws header, rooms, body, ticker and keys for every home view
- [x] #3 The key table carries label, when and priority, and the footer hints come from it with no per-view hint lists
- [x] #4 A Composer multi-line input exists where Enter adds a line, ctrl-s sends and Esc cancels
- [x] #5 Existing TUI tests pass unchanged apart from colour assertions
- [x] #6 Below 60 columns or below 16 rows the TUI shows "Widen the terminal to at least 60 columns" instead of the layout
- [ ] #7 The four theme mocks of screens/17-themes.txt match the HTML preview's S10 in truecolor light, 16 colours light and dark, and NO_COLOR. The screens must match `docs/design/tui-v2/designs/dipo-ux-spec.html` exactly; the text mocks in `screens/` are the same screens in text
- [x] #8 The planning view uses the Composer; its own input code is gone
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-06 15:40 UTC
- Criteria met: 7 of 8 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 2, failed 1
- Budget used: 228,702 of 800,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 1
<!-- SECTION:FINAL_SUMMARY:END -->
