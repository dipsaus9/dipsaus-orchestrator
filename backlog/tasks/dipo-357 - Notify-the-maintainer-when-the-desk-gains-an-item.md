---
id: DIPO-357
title: Notify the maintainer when the desk gains an item
status: Done
assignee: []
created_date: '2026-10-25 09:51'
updated_date: '2026-10-30 07:30'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-351
references:
  - packages/engine/src/views/desk.ts
  - packages/daemon/src/
  - packages/engine/src/platform/
  - packages/engine/src/config/
  - packages/engine/src/config/software.ts
modified_files:
  - packages/client/test/unit/config.test.ts
  - packages/client/test/unit/lifecycle.test.ts
  - packages/contract/schema/config.schema.json
  - packages/contract/src/config.test.ts
  - packages/contract/src/config.ts
  - packages/daemon/src/foreground-bootout.test.ts
  - packages/daemon/src/foreground.ts
  - packages/daemon/test/integration/foreground.ci.test.ts
  - packages/engine/src/create/create-engine.ts
  - packages/engine/src/create/deps.ts
  - packages/engine/src/platform-entry.ts
  - packages/engine/src/platform/notify.ts
  - packages/engine/src/views/desk-notify.ts
  - packages/engine/test/config/software.test.ts
  - packages/engine/test/entries.test.ts
  - packages/engine/test/platform/notify.test.ts
  - packages/engine/test/views/desk-notify.test.ts
priority: medium
type: feature
ordinal: 337000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: when an item is added to an office's desk, the daemon shows one macOS notification naming the office, the story and what waits, unless notifications are off in config.yaml.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. Maintainer decision of 2026-10-24 (gap c of the user flow; 0009).

```dipo
branch: "DIPO-357/desk-notifications"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine, fake platform) each new desk item posts once and a repeated read posts nothing"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A new desk item posts one notification with the office, the story and the kind of wait, and an item already shown is not shown again
- [x] #2 notify.desk in <state>/config.yaml turns notifications off, and it defaults to on
- [x] #3 The notification goes through the platform module, and a failed post is logged and never stops the daemon
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-10-30 07:30 UTC
- Criteria met: 3 of 3 (as the worker reported them)
- Loops: 0; CI attempts: 0
- Review rounds: 1, failed 0
- Budget used: 172,024 of 300,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 1
<!-- SECTION:FINAL_SUMMARY:END -->
