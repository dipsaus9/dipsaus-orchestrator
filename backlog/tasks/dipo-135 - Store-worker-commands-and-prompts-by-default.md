---
id: DIPO-135
title: Store worker commands and prompts by default
status: Refined
assignee: []
created_date: '2026-10-16 19:08'
updated_date: '2026-10-16 19:08'
labels:
  - 'tier:S'
  - 'slice:m1a'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/config/
  - packages/engine/schema/
  - packages/engine/src/views/summary.ts
  - packages/engine/test/config/
  - packages/engine/test/views/
  - packages/tui/src/overview.tsx
  - packages/tui/src/overview.test.tsx
  - packages/contract/src/
priority: medium
type: feature
ordinal: 125000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the maintainer sees what a worker ran and what it was told without setting anything, because privacy.storeCommandBodies and privacy.storePrompts are on by default; .dipo/office.local.yaml can still turn either off.

Context: 0007 section 8 made all three privacy settings opt-ins, off by default. During the DIPO-115 cutover the maintainer wanted to see the bash commands of a run and decided (2026-10-16) that commands and prompts are stored by default. privacy.keepRawEvents stays off. The defaults live in OFFICE_DEFAULTS (packages/engine/src/config/schema.ts); privacyOptIns feeds the overview (packages/engine/src/views/summary.ts), which shows the settings that are on with the word opt-in (packages/tui/src/overview.tsx). With commands and prompts on by default that word is wrong, so the overview names them as stored data instead. A changed default needs no config version bump (only a new key does, 0017 amendment of 2026-10-12).

```dipo
branch: "DIPO-135/store-commands-prompts-default"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) an office with no privacy keys resolves storeCommandBodies and storePrompts to true and keepRawEvents to false, and office.local.yaml set to false turns each one off"
    - kind: "automated"
      check: "(unit) the overview lists the privacy settings that are on without the word opt-in, and lists none when office.local.yaml turns all three off"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 With no privacy keys in .dipo/office.local.yaml, privacy.storeCommandBodies and privacy.storePrompts resolve to true and privacy.keepRawEvents to false; setting either of the first two to false in office.local.yaml turns it off
- [ ] #2 The office config JSON Schema packages/engine/schema/office.schema.json (written by bun packages/engine/scripts/write-schema.ts) and the config tests show the new defaults
- [ ] #3 The TUI overview and the summary view name the privacy settings that are on as stored data (for example stores commands, prompts) instead of opt-in, and show nothing when all three are off
<!-- AC:END -->
