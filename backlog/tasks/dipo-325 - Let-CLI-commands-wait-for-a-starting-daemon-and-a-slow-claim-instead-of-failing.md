---
id: DIPO-325
title: >-
  Let CLI commands wait for a starting daemon and a slow claim instead of
  failing
status: Done
assignee: []
created_date: '2026-10-23 09:11'
updated_date: '2026-10-23 10:30'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/cli/src/
  - packages/client/src/
modified_files:
  - packages/cli/src/office-commands.test.ts
  - packages/cli/src/office-commands.ts
  - packages/cli/src/run-command.test.ts
  - packages/cli/src/run-command.ts
  - packages/cli/src/watch-command.test.ts
  - packages/client/src/recovery.ts
  - packages/client/test/unit/recovery.test.ts
priority: medium
type: bug
ordinal: 310000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: no dipo CLI command prints a stack trace or gives up while the daemon is starting, recovering or still claiming a story; each waits within a stated limit and says what it waits for.

Context: on 2026-10-23, dipo office rescan right after a daemon restart threw an unhandled engine.recovering error with a stack trace (from the scan subscription's onEnded) instead of waiting as the commands of DIPO-86 do; and dipo run gave up after 300 s ("the daemon did not answer") while the claim of a box run took 5.5 minutes before DIPO-240 removed the Mac setup install (the run started anyway). 0003 and 0009 (CLI behaviour), DIPO-86.

```dipo
branch: "DIPO-325/cli-waits"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) office rescan sent while the daemon is recovering waits for running and then rescans, and never prints a stack trace"
    - kind: "automated"
      check: "(unit) dipo run waits for a claim that takes longer than the read timeout and reports the started run, or says plainly that the run is still being claimed"
    - kind: "automated"
      check: "(unit) every CLI command that subscribes to a stream handles engine.recovering and a closed stream without an unhandled error"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 dipo office rescan sent while the daemon is recovering waits until it runs, then rescans; no CLI command prints a stack trace for engine.recovering
- [x] #2 dipo run waits for a slow claim within a stated limit and then reports the started run, or says plainly that the claim is still going and how to follow it
- [x] #3 Every CLI command that subscribes to a stream handles engine.recovering and a closed stream without an unhandled error
- [x] #4 Tests cover rescan during recovery, a slow claim and a closed stream
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-10-23 10:30 UTC
- Criteria met: 4 of 4 (as the worker reported them)
- Loops: 0; CI attempts: 0
- Review rounds: 1, failed 0
- Budget used: 222,185 of 500,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 0
<!-- SECTION:FINAL_SUMMARY:END -->
