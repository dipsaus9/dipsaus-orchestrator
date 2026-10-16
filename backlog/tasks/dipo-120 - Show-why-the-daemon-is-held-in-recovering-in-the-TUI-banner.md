---
id: DIPO-120
title: Show why the daemon is held in recovering in the TUI banner
status: To Do
assignee: []
created_date: '2026-10-16 11:52'
updated_date: '2026-10-16 11:56'
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
  - packages/client/test
priority: medium
type: feature
ordinal: 110000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: when the daemon is held in recovering because its database is unavailable (DIPO-111), the TUI banner says so and shows the reason and the newest backup, instead of the generic "Daemon recovering – office data after reconcile", which suggests it will clear by itself.

Context: DIPO-111 holds the daemon in recovering and answers reads with the non-retryable code database.unavailable (DatabaseUnavailableDetails { reason, backup? }, packages/contract/src/errors.ts). That code ends the retry in packages/client/src/recovery.ts and in the office store (whose retry runs on a RECOVERY_POLL_MS timer). The store keeps the failed read's EngineError in OfficeStoreState.error, details untyped, until the next success, but not daemon.status stateReason. The TUI never renders state.error, and bannerLines in packages/tui/src/views.tsx only switches on the daemon state. 0009 section 7 fixes the recovering banner text, so this needs a dated 0009 note. Found while delivering DIPO-111.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 While the daemon answers database.unavailable, the banner shows a database line with the reason and, when given, the newest backup path, in place of the reconcile line
- [ ] #2 The ordinary recovering banner (reconcile after a start) is unchanged
- [ ] #3 The client store exposes the database line as typed state (DatabaseUnavailableDetails parsed from the error's details) that the TUI reads, also with no office selected and across an office switch; no UI imports engine internals
- [ ] #4 The database line clears when the daemon state goes to draining and after a reconnect to a daemon that answers reads again (a fresh engine.hello), with tests
- [ ] #5 Tests cover the banner text in both cases and in ASCII mode
- [ ] #6 A dated 0009 section 7 note for the database line is proposed in the PR for the maintainer's approval
<!-- AC:END -->
