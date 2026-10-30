---
id: DIPO-385
title: Make 0005's error codes and the contract's list one list
status: Done
assignee: []
created_date: '2026-10-30 09:30'
updated_date: '2026-10-30 16:14'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-355
references:
  - packages/contract/src/errors.ts
  - docs/decisions/0005-command-and-event-model.md
modified_files:
  - docs/decisions/0005-command-and-event-model.md
  - packages/contract/src/definition.ts
  - packages/contract/src/errors.test.ts
  - packages/contract/src/index.test.ts
  - packages/contract/src/office.ts
  - packages/contract/src/profile.ts
  - packages/contract/src/software.ts
  - packages/contract/src/work.ts
priority: medium
type: chore
ordinal: 365000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the generic error codes and the retryable codes in 0005 match `packages/contract/src/errors.ts` exactly, and the contract file no longer carries notes about contract minors.

Found by the review of PR #458 (DIPO-355): errors.ts lists more generic codes than 0005, `scheduling.off` is missing from 0005's retryable list, and the "Since minor 1" notes are stale now that contract versions are gone. 0005, 0001.

```dipo
branch: "DIPO-385/error-codes-one-list"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(contract) a test reads the code list and checks every generic and retryable code is documented"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 0005 lists the generic codes and the retryable codes as two explicit lists of backticked codes (the generic sentence no longer mixes in the retryable ones), and they match packages/contract/src/errors.ts exactly, scheduling.off included
- [x] #2 A contract test reads those two lists from 0005 and fails when errors.ts has a generic or retryable code the ADR does not list, or the reverse; the software and office code lists are out of scope
- [x] #3 No "Since minor" note remains in the contract package
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-10-30 16:14 UTC
- Criteria met: 3 of 3 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 1, failed 0
- Budget used: 54,321 of 300,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 1
<!-- SECTION:FINAL_SUMMARY:END -->
