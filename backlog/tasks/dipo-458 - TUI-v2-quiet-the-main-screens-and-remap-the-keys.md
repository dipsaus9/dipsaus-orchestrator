---
id: DIPO-458
title: 'TUI v2: quiet the main screens and remap the keys'
status: In Progress
assignee: []
created_date: '2026-11-06 14:12'
updated_date: '2026-11-07 11:49'
labels:
  - 'tier:S'
milestone: m-6
dependencies:
  - DIPO-457
references:
  - packages/tui/src/app.tsx
  - packages/tui/src/views.tsx
  - packages/tui/src/keys.ts
  - docs/design/tui-v2/spec.md
  - docs/design/tui-v2/keymap.json
  - docs/design/tui-v2/screens/08-offices.txt
  - docs/design/tui-v2/screens/12-states.txt
  - docs/design/tui-v2/designs/dipo-ux-spec.html
  - packages/contract/src/office.ts
  - packages/engine/src/overview
priority: medium
type: feature
ordinal: 431000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want the run result, privacy words and duplicate key hints gone from the main screens, so that I see at a glance what the team does and what needs me.

Step 2. The RunResult skipped block clears on the next key and goes to the ticker. Privacy words leave the header. Keys follow keymap.json changedFromToday: R run, X drop, p park, O offices, q q quits, `c` copies, `z` expands the stream, Offices takes `a` for a new path, and there is no undo, privacy in settings. The header is dipo / office, `+2 elsewhere · O` when other offices need you, the daemon dot, spend today and the time. Spend today is an engine addition this step makes: office.summary carries it (DayUsage.estimatedCost on dayUsage may already hold it; check first). Offices' idle N days needs a second engine addition: last activity per office in OfficeSummary. Offline, recovering and daemon stopped get their bodies and header chips, and Offices gets its columns, as the screens show.

Design: docs/design/tui-v2/ (spec.md, screens/, keymap.json, roles.json, migration.md). The screens must match `docs/design/tui-v2/designs/dipo-ux-spec.html` exactly; the text mocks in `screens/` are the same screens in text. Where spec.md's Maintainer decisions (2026-11-06) differ from the HTML, the text files win.

```dipo
branch: "DIPO-458/tui-v2-quiet"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the skipped block is gone after the next key and the ticker shows one line"
    - kind: "manual"
      check: "Open the TUI on this repository and run the next Ready story with R"
      expect: "No skipped list stays on screen; its summary shows once in the ticker"
    - kind: "manual"
      check: "Open the TUI next to designs/dipo-ux-spec.html, compare the header and footer of each room, open Offices with O, then stop the daemon"
      expect: "Header, footer, Offices (S2e) and the daemon stopped and offline states (S6, S8) match the HTML preview side by side"
    - kind: "manual"
      check: "Open the TUI in a dark and a light terminal, each with and without DIPO_TUI_THEME=classical (the opt-in truecolor switch DIPO-457 adds), and once with NO_COLOR=1, next to designs/dipo-ux-spec.html S10 (Tweaks: dark/light, truecolor/ansi16)"
      expect: "Header, footer and Offices show the roles as S10 shows them in each theme; under NO_COLOR only ▌ marks the focus row (moved here from DIPO-457, maintainer 2026-11-07)"
    - kind: "automated"
      check: "(unit) office.summary carries spend today and the header prints it"
    - kind: "automated"
      check: "(unit) q quits only when pressed twice within 2 s"
    - kind: "automated"
      check: "(unit) OfficeSummary carries last activity and Offices prints idle N days"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The skipped list of a run no longer stays under every view; its summary shows once in the ticker
- [ ] #2 The header shows dipo / office, `+2 elsewhere · O` when other offices need you, the daemon dot and word, spend today and the time only
- [ ] #3 Keys follow keymap.json changedFromToday, and the footer shows the new keys
- [ ] #4 Offline shows the frozen body in shade with action keys removed from the footer; recovering with a database problem and daemon stopped show the bodies of screens/12-states.txt
- [ ] #5 Offices lists NEEDS YOU first in bold acc, RUNNING, READY and the TODAY bar, with the live, starts paused and idle glyphs
- [ ] #6 The header, footer, Offices and daemon state screens match the HTML preview. The screens must match `docs/design/tui-v2/designs/dipo-ux-spec.html` exactly; the text mocks in `screens/` are the same screens in text
- [ ] #7 office.summary carries today's spend (engine addition), and the header reads it from there
- [ ] #8 OfficeSummary carries each office's last activity (engine addition), and Offices shows idle N days from it
- [ ] #9 Header, footer and Offices show the colour roles as the HTML preview's S10 shows them in truecolor and 16 colours, dark and light, and under NO_COLOR (the S10 look check moved here from DIPO-457)
<!-- AC:END -->
