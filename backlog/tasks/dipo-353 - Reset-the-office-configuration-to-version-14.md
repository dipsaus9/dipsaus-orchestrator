---
id: DIPO-353
title: Reset the office configuration to version 14
status: Refined
assignee: []
created_date: '2026-10-25 09:51'
updated_date: '2026-10-25 09:55'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-351
references:
  - packages/engine/src/config/
  - packages/engine/schema/
  - packages/contract/src/config.ts
  - .dipo/office.yaml
priority: medium
type: chore
ordinal: 333000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the office configuration is version 14 with only the keys code reads and a default for each, one migration takes any earlier version to it and names the dropped keys, and a new key with a default needs no version bump from then on.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. 0017 sections 5 to 7 and accepted proposal 11.

```dipo
branch: "DIPO-353/office-config-v14"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(config) fixtures of every earlier version migrate to version 14 and name each dropped key"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Version 14 has the sections of the 0017 sample, each key optional with a default (timeouts.testIdleMinutes from DIPO-309 included), and every key that code does not read is gone
- [ ] #2 One migration takes a file of any earlier version to version 14, drops retired keys with a warning naming them, and dipo config migrate rewrites the file keeping its comments
- [ ] #3 An unknown key is an error that names the key and says it may need a newer dipo
- [ ] #4 This repository's .dipo/office.yaml is migrated to version 14
<!-- AC:END -->
