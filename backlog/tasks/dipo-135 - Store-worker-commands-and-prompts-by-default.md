---
id: DIPO-135
title: Store worker commands by default
status: Ready
assignee: []
created_date: '2026-10-16 19:08'
updated_date: '2026-10-17 22:39'
labels:
  - 'tier:S'
  - 'slice:m1a'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/config/
  - packages/engine/test/config/
  - packages/tui/src/views.tsx
  - packages/tui/src/overview.tsx
  - packages/tui/src/overview.test.tsx
  - packages/tui/src/detail.tsx
  - packages/tui/src/detail.test.tsx
priority: medium
type: feature
ordinal: 125000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the maintainer sees the commands a worker ran without setting anything, because privacy.storeCommandBodies is on by default; `privacy.storeCommandBodies: false` in .dipo/office.local.yaml turns it off.

Context: 0007 section 8 made all three privacy settings opt-ins, off by default. During the DIPO-115 cutover the maintainer wanted to see the bash commands of a run and decided (2026-10-16) that commands are stored by default, and prompts too from the story that stores them. privacy.keepRawEvents stays off. The maintainer adds the ADR 0007 note separately; this story does not edit docs/decisions/.

The default lives in OFFICE_DEFAULTS.privacy (packages/engine/src/config/schema.ts). privacy.storePrompts stays false here: nothing reads it yet (packages/engine/src/prompts/parts.ts stores hashes and sizes, no text), and DIPO-137, which stores the assembled prompt text, turns it on. The fallbacks used when an office has no configuration in force stay off as the safe default: DEFAULT_OUTPUT_PRIVACY in packages/engine/src/ingest/output.ts and the `?? false` in packages/daemon/src/runs.ts. This story does not change them.

Stored commands get no redaction: a command with a token in it is stored as written. Tier R retention (retention.shortDays, 0007 section 7) is their only limit. packages/engine/test/ingest/command-bodies.test.ts tests the off case through the ingestor, both without a privacy function and with an explicit false; it does not read OFFICE_DEFAULTS, so it needs no change and keeps testing the off case with an explicit false.

The TUI names the settings that are on with the word opt-in: optInLabel in packages/tui/src/views.tsx builds `opt-in storeCommandBodies`, shown in the overview count line (packages/tui/src/overview.tsx) and in the detail's worker-output title (packages/tui/src/detail.tsx, pinned by detail.test.tsx). With commands on by default that word is wrong, so both name the stored data instead. The contract field OfficeSummary.optIns and the engine function privacyOptIns keep their names, so the contract and packages/engine/src/views/ do not change.

A changed default needs no config version bump (only a new key does, 0017 amendment of 2026-10-12). packages/engine/schema/office.schema.json is the committed office.yaml schema, which rejects privacy.*, so it does not change either.

```dipo
branch: "DIPO-135/store-commands-by-default"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) an office with no privacy keys resolves storeCommandBodies to true and storePrompts and keepRawEvents to false, privacyOptIns(OFFICE_DEFAULTS) is [\"privacy.storeCommandBodies\"], and office.local.yaml with storeCommandBodies: false turns it off"
    - kind: "automated"
      check: "(unit) the overview count line and the worker-output title in the detail show `stores commands` while storeCommandBodies is on, never the word opt-in, and no label when no privacy setting is on"
    - kind: "manual"
      check: "(live) with no .dipo/office.local.yaml in the scratch repo, run a story that uses Bash and open its worker output and the overview"
      expect: "the worker output shows `[tool] Bash <command>` lines and the overview shows `stores commands`"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 With no privacy keys in .dipo/office.local.yaml, privacy.storeCommandBodies resolves to true and privacy.storePrompts and privacy.keepRawEvents to false (OFFICE_DEFAULTS.privacy in packages/engine/src/config/schema.ts); `privacy.storeCommandBodies: false` in office.local.yaml turns it off
- [ ] #2 The no-configuration fallbacks stay off as the safe default: DEFAULT_OUTPUT_PRIVACY in packages/engine/src/ingest/output.ts and the `?? false` in packages/daemon/src/runs.ts are unchanged, so an office without a configuration in force stores no commands
- [ ] #3 The tests that pin the old defaults in packages/engine/test/config/schema.test.ts (the OFFICE_DEFAULTS.privacy check and privacyOptIns(OFFICE_DEFAULTS)) assert the new defaults, and packages/engine/test/ingest/command-bodies.test.ts still tests the off case with an explicit false
- [ ] #4 optInLabel in packages/tui/src/views.tsx is replaced by a label that names the stored data (`stores commands`, `stores prompts`, `keeps raw events`, joined with commas) instead of the word opt-in; the overview count line (overview.tsx) and the worker-output title in the detail (detail.tsx) use it, overview.test.tsx and detail.test.tsx assert the new text, and neither shows a label when no privacy setting is on
- [ ] #5 The contract field OfficeSummary.optIns and the engine function privacyOptIns keep their names: no contract change and no change in packages/engine/src/views/
<!-- AC:END -->
