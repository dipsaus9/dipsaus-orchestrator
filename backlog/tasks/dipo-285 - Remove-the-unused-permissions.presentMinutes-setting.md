---
id: DIPO-285
title: Remove the unused permissions.presentMinutes setting
status: Done
assignee: []
created_date: '2026-10-21 14:35'
updated_date: '2026-10-21 17:39'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies:
  - DIPO-266
references:
  - packages/engine/src/config/schema.ts
  - packages/engine/schema/office.schema.json
  - packages/engine/test/config/
  - packages/engine/src/config/load.ts
  - packages/engine/src/config/index.ts
  - packages/engine/src/office/manager.ts
  - packages/engine/test/office/config.test.ts
  - packages/engine/test/office/load.test.ts
type: feature
ordinal: 274000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the office config no longer has permissions.presentMinutes, which nothing reads since DIPO-279; a config that still sets it loads with a warning that names the key.

Context: DIPO-279 replaced the presence window with a check for a connected TUI (0021 section 11). The key is still in the schema, the defaults, the JSON schema and the config tests.

```dipo
branch: "DIPO-285/drop-present-minutes"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 permissions.presentMinutes is gone from packages/engine/src/config/schema.ts, its defaults and packages/engine/schema/office.schema.json
- [x] #2 A config that still sets it loads, with a warning that names the key
- [x] #3 The config tests are updated and cover the warning
<!-- AC:END -->
