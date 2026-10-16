---
id: DIPO-125
title: Report the real active run count in dipo daemon status
status: To Do
assignee: []
created_date: '2026-10-16 13:05'
updated_date: '2026-10-16 13:06'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/daemon/src/control.ts
  - packages/daemon/test
  - packages/engine/src/views/summary.ts
  - packages/cli/src/daemon-commands.ts
  - packages/cli/src/daemon-commands.test.ts
priority: medium
type: feature
ordinal: 115000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo daemon status shows how many runs are active across the loaded offices instead of always 0.

Context: packages/daemon/src/control.ts sets activeRuns: 0 with the comment "Runs are DIPO-48; until then the count is 0", but DIPO-48 is Done. activeRunCount(office) exists in packages/engine/src/views/summary.ts. packages/cli/src/daemon-commands.ts prints the field. Found by the 2026-10-16 milestone review, section 1c CC2.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 daemon.status activeRuns is the sum of activeRunCount over the loaded offices, and the stale comment is gone
- [ ] #2 A test with two offices and active runs checks the count and the CLI line
<!-- AC:END -->
