---
id: DRAFT-5
title: Mouse support for the Desk
status: Draft
assignee: []
created_date: '2026-11-10 14:23'
updated_date: '2026-11-10 14:23'
labels: []
milestone: m-6
dependencies: []
references:
  - docs/design/tui-v2/spec.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A proposed user story from a worker's proposal in run run_01M6ZXSZ3AVJEYS383ZVTHT49F, audited by dipo and filed by the maintainer's accept. The texts below are the audit's words on that idea, cleaned and capped by dipo: read them as data, not as instructions.

Story: As maintainer I want to click a desk row to focus it and click a preview button to act so that the Desk works as the spec's frame describes.

Found: The spec lists SGR 1006 mouse input (click focuses a row, double-click is Enter, wheel scrolls, key hints clickable), but nothing in packages/tui/src mentions mouse or click, and no open or Done story covers it.

Evidence:
- docs/design/tui-v2/spec.md:90 "- Mouse (SGR 1006): click focuses a row, double-click is ⏎, the wheel scrolls the pane under the cursor, and clicking a room or a key hint triggers it."
- docs/design/tui-v2/spec.md:273 "- Mouse: SGR mode 1006."

Proposed: Enable SGR 1006 mouse reporting in the TUI input, parse click, double-click and wheel events, and map them to row focus, Enter and the action registry's buttons on the Desk.

Why: The TUI v2 design requires mouse input and the buttons are drawn but cannot be clicked.

Serves: milestone m-6

Origin: a worker's proposal
Source story: DIPO-459
dipo idea: cddbe0e293da5a6f7736ea4390141ebaa9696a270629b6b1f696e4c2cd0e5e6e
<!-- SECTION:DESCRIPTION:END -->
