---
id: DIPO-463
title: 'TUI v2: command palette, keys overlay, the Plan view and the Retro room'
status: Done
assignee: []
created_date: '2026-11-06 14:12'
updated_date: '2026-11-08 11:00'
labels:
  - 'tier:M'
milestone: m-6
dependencies:
  - DIPO-457
  - DIPO-449
  - DIPO-453
references:
  - packages/tui/src/settings.tsx
  - packages/tui/src/keys.ts
  - docs/design/tui-v2/spec.md
  - docs/design/tui-v2/screens/09-palette.txt
  - docs/design/tui-v2/screens/13-keys-overlay.txt
  - docs/design/tui-v2/screens/07-plan.txt
  - docs/design/tui-v2/screens/06-retro.txt
  - docs/design/tui-v2/designs/dipo-ux-spec.html
priority: medium
type: feature
ordinal: 436000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want a command palette and a keys overlay built from the same registry as the footer, so that I can find every action and setting without remembering keys.

Step 7. : and ctrl-k open a fuzzy palette scoped to the focused item first, with disabled rows saying why. ? opens the keys overlay. Stopping a run is a palette row only (no key) and asks to confirm. Settings and privacy move into the palette; its rows show their keys (p park, z expand stream, O offices). The Retro room (room 4) and the Plan view (P) are mounted in the Frame for DIPO-453 and DIPO-449, laid out as screens/06-retro.txt and screens/07-plan.txt.

Design: docs/design/tui-v2/ (spec.md, screens/, keymap.json, roles.json, migration.md). The screens must match `docs/design/tui-v2/designs/dipo-ux-spec.html` exactly; the text mocks in `screens/` are the same screens in text. Where spec.md's Maintainer decisions (2026-11-06) differ from the HTML, the text files win.

```dipo
branch: "DIPO-463/tui-v2-palette"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) palette fuzzy match and scoping order"
    - kind: "automated"
      check: "(unit) keys overlay lists the same keys as the footer registry"
    - kind: "manual"
      check: "Open the palette with : and type pa, then open ? on a merge item, next to designs/dipo-ux-spec.html S5 and S9"
      expect: "Both overlays match the HTML preview side by side, with the body behind them in shade"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 : and ctrl-k open a palette listing the focused item's actions first, then settings, then navigation, each with its key
- [x] #2 A disabled action stays listed with its reason
- [x] #3 ? shows the keys of the focused item, movement and global keys, from the registry
- [x] #4 Privacy settings are reached through the palette and keep their yes/no confirmation
- [x] #5 The Retro room (room 4) and the Plan view (P) are slots in the Frame that DIPO-453 and DIPO-449 fill
- [ ] #6 The palette and the keys overlay match the HTML preview's S5 and S9, and the Retro room and the Plan view follow S2c and S2d. The screens must match `docs/design/tui-v2/designs/dipo-ux-spec.html` exactly; the text mocks in `screens/` are the same screens in text
- [x] #7 Stopping a run is reached only through the palette and asks to confirm
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parked 2026-11-08 09:36 UTC: verify-failing
- Detail: required checks were red on 2 pushed heads (the CI cap is 2). Required check ci-ok failed on the pushed head.
- Run: run_01M6X6ZDB52E3W5Z51THYHVQHY
- Criteria met: 7 of 7 (as the worker reported them)
- Loops: 0 of 5; CI attempts: 2 of 2
- Review rounds: 2, failed 1 of 3
- Budget used: 267,652 of 800,000 tokens; 65 of 200 turns; 17 of 90 minutes
- Last good commit: 979609413b3667c0234e4e41582ac90c48a0997f

Resumed 2026-11-08 09:45 UTC; grants: +1 CI attempt; note: The red CI was not your code: actionlint and CodeQL downloads got HTTP 504 from GitHub. DIPO-458 (PR #625) is now merged on main and changes keys.ts, footer.ts, frame.tsx, app.tsx, home.tsx and the h…

Parked 2026-11-08 09:46 UTC: ambiguous-spec
- Detail: The box has no remote and no origin/main, and its only commit is "Start of the story", so I cannot merge DIPO-458 (PR #625). Can dipo put 458's merged main into the box, for example by rebasing the s…
- Run: run_01M6X6ZDB52E3W5Z51THYHVQHY
- Criteria met: 6 of 7 (as the worker reported them)
- Loops: 0 of 5; CI attempts: 2 of 3
- Review rounds: 2, failed 1 of 3
- Budget used: 300,984 of 800,000 tokens; 71 of 200 turns; 13 of 90 minutes
- Last good commit: 3a02bbed87be232e6f3251c60640335c37393e84
<!-- SECTION:NOTES:END -->
