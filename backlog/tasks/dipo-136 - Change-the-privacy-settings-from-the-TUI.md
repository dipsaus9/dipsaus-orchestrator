---
id: DIPO-136
title: Change the privacy settings from the TUI
status: Refined
assignee: []
created_date: '2026-10-16 19:09'
updated_date: '2026-10-16 19:09'
labels:
  - 'tier:M'
  - 'slice:m1b'
milestone: m-1
dependencies:
  - DIPO-135
references:
  - packages/contract/src/
  - packages/daemon/src/
  - packages/daemon/test/
  - packages/client/src/
  - packages/engine/src/config/
  - packages/engine/test/config/
  - packages/tui/src/
priority: medium
type: feature
ordinal: 126000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the maintainer turns storing worker commands, prompts and raw events on or off from the TUI, without editing .dipo/office.local.yaml by hand, and the change applies from the next run.

Context: the privacy settings (0007 section 8) are machine-local and accepted only in .dipo/office.local.yaml (0017 section 5). Today the TUI only reads; changing a setting means editing that file. UIs never write engine files (CLAUDE.md, engine is headless), so the TUI sends a command and the daemon validates and writes the file with the existing config schema (packages/engine/src/config/). The file keeps every other key it holds (timeouts, retention); comments in it are not kept, and the TUI says so before the first write. A running story keeps the settings it started with, because each run stores its config hash (0017 section 5). Asked for by the maintainer during the DIPO-115 cutover (2026-10-16); part of the M1b TUI desk.

```dipo
branch: "DIPO-136/tui-privacy-settings"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the daemon command writes the requested privacy value to office.local.yaml, keeps its timeouts and retention keys, creates the file with version 2 when it is missing, and refuses an unknown key or a non-boolean value with the key named"
    - kind: "automated"
      check: "(unit) the TUI settings view shows the three privacy settings with their effective values and sends the command when one is toggled"
    - kind: "manual"
      check: "(live) toggle storeCommandBodies off in the TUI, start a run on the scratch repo, and see tool names without commands in its output; toggle it on and the next run shows the commands"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A contract command changes one privacy setting (storeCommandBodies, storePrompts or keepRawEvents) of an office; the daemon validates it with the office config schema and writes .dipo/office.local.yaml, keeping the other keys in the file and creating it with version 2 when it is missing
- [ ] #2 An unknown key, a non-boolean value or an office.local.yaml that does not validate is refused with the file and key named, and the file is left unchanged
- [ ] #3 The TUI has a settings view, opened from the overview, that lists the three privacy settings with their effective values and whether each comes from the default or office.local.yaml, and toggles one with a confirmation that names what is stored and that it applies from the next run
- [ ] #4 A run that is already going keeps the settings it started with; the next run uses the new value
<!-- AC:END -->
