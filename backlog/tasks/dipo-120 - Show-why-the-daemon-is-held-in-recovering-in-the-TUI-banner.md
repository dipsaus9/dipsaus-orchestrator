---
id: DIPO-120
title: Show why the daemon is held in recovering in the TUI banner
status: To Do
assignee: []
created_date: '2026-10-16 11:52'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/tui/src
  - packages/client/src/store
  - packages/client/src/recovery.ts
  - packages/contract/src/errors.ts
  - docs/decisions/0009-tui.md
priority: medium
type: feature
ordinal: 110000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: when the daemon is held in recovering because its database is unavailable (DIPO-111), the TUI banner says so and shows the reason and the newest backup, instead of the generic "Daemon recovering – office data after reconcile", which suggests it will clear by itself.

Context: DIPO-111 holds the daemon in recovering with the non-retryable code database.unavailable (DatabaseUnavailableDetails { reason, backup? }, packages/contract/src/errors.ts) after a failed migration or a failed quick_check. The client re-sends after every answered daemon.status poll (packages/client/src/recovery.ts, office-store). The office store does not keep stateReason or the database.unavailable details, and bannerLines in packages/tui/src/views.tsx only switches on the daemon state. Found while delivering DIPO-111.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 While the daemon answers database.unavailable, the banner shows a database line with the reason and, when given, the newest backup path, in place of the reconcile line
- [ ] #2 The ordinary recovering banner (reconcile after a start) is unchanged, and the database line clears when the daemon leaves recovering
- [ ] #3 The office store keeps the last database.unavailable details (or stateReason) as state the TUI reads; no UI imports engine internals
- [ ] #4 Tests cover the banner text in both cases, ASCII mode, and the line clearing
<!-- AC:END -->
