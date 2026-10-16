---
id: DIPO-91
title: Stop the logger from hiding error codes
status: To Do
assignee: []
created_date: '2026-10-15 16:49'
updated_date: '2026-10-15 21:20'
labels:
  - 'tier:S'
milestone: m-0
dependencies: []
references:
  - packages/engine/src/log/logger.ts
  - docs/decisions/0006-daemon-and-ipc.md
  - packages/engine/test/log/logger.test.ts
priority: medium
type: feature
ordinal: 81000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: log lines show error codes such as engine.recovering or office.notFound, while secrets stay redacted.

Context: seen in the M0 delivery sessions: warn and error lines said code: [redacted]. The logger redacts every field named code, token or session.token at any depth (packages/engine/src/log/logger.ts:2-3, 20). Error codes are logged under code, for example office refused (packages/engine/src/office/manager.ts:280) and spread EngineError objects (packages/daemon/src/foreground.ts:223, packages/engine/src/host/main.ts:295). The rule comes from 0006 decision 13 (docs/decisions/0006-daemon-and-ipc.md:222), whose intent is the daemon.webBootstrap code; changing which field names are redacted needs a 0006 amendment approved by the maintainer.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The maintainer approves a 0006 decision 13 amendment that names the secret fields (for example bootstrapCode, token, session.token) instead of every field named code, and it is recorded in docs/decisions/0006-daemon-and-ipc.md.
- [ ] #2 Secret values that were logged as code are renamed to the new field name at their source, and the redaction set follows the amendment.
- [ ] #3 Tests show an EngineError code in a warn line and a web bootstrap code still redacted at any depth.
<!-- AC:END -->
