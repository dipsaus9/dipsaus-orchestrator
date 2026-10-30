---
id: DIPO-382
title: Remove the quick_check after an unclean exit
status: Refined
assignee: []
created_date: '2026-10-30 07:04'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-354
references:
  - packages/daemon/src/crash-counter.ts
  - packages/engine/src/db/
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
- [ ] #2 Opening the state database after an unclean exit runs no PRAGMA quick_check, and nothing holds the daemon for a check result
- [ ] #3 No comment or message in the daemon or engine mentions dipo restore or a quick_check after an unclean exit
<!-- AC:END -->
