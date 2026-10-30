---
id: DIPO-382
title: Remove the quick_check after an unclean exit
status: Refined
assignee: []
created_date: '2026-10-30 07:04'
updated_date: '2026-10-30 07:05'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-354
references:
  - packages/daemon/src/crash-counter.ts
  - packages/daemon/src/foreground.ts
  - packages/engine/src/platform/sqlite.ts
  - packages/engine/src/create/deps.ts
  - packages/engine/src/create/recovery.ts
  - packages/engine/src/create/steps.ts
  - packages/contract/src/errors.ts
  - packages/daemon/test/integration/crash-loop.test.ts
  - packages/engine/test/
  - docs/decisions/0007-state-database.md
priority: low
type: chore
ordinal: 362000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the daemon no longer runs `PRAGMA quick_check` after an unclean exit, as 0007 already says; the crash counter keeps only its crash list and the `running` marker.

0007 lists "a `quick_check` after unclean exits" among the mechanisms the pre-migration backup replaced (2026-10-24), but `packages/daemon/src/crash-counter.ts` still keeps `needsCheck` (DIPO-111) and the state database open still runs the check. Its comment still mentions a restore, which DIPO-354 removed. Found by the review of PR #425. It removes `needsCheck`, the quick_check at open and the hold for a damaged file that depends on it; a file older than the crash counter's new shape still loads (an unknown `needsCheck` field is ignored). 0007, 0006, 0001.

```dipo
branch: "DIPO-382/remove-quick-check"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the crash counter reads a file with and without needsCheck, and the database open after an unclean exit runs no quick_check"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 crash-counter.ts keeps no needsCheck; a counter file that still has the field loads, and the field is dropped on the next write
- [ ] #2 Nothing runs PRAGMA quick_check at open: the check and its damaged error in platform/sqlite.ts, the databaseCheck/needsCheck deps in create/deps.ts, needsCheckAfter in create/recovery.ts, the check step and its log line in create/steps.ts, and the needsCheck decision and wiring in daemon/src/foreground.ts are removed, with the tests that asserted them (crash-loop, sqlite, recovery, lifecycle) updated
- [ ] #3 A damaged or unreadable state database still ends in database.unavailable with the recovery-by-hand text (0007), shown by a test against the real open path with a corrupted fixture file
- [ ] #4 No comment or message in the files this story touches mentions dipo restore or a quick_check after an unclean exit
<!-- AC:END -->
