---
id: DIPO-377
title: Fix the flake in the backlog PR check test
status: Parked
assignee: []
created_date: '2026-10-29 09:29'
updated_date: '2026-10-30 10:57'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-351
references:
  - scripts/check-backlog-pr.test.ts
  - scripts/
priority: medium
type: bug
ordinal: 357000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: scripts/check-backlog-pr.test.ts passes on every verify-macos run.

Found on 2026-10-29: 'passes a story made Ready…' (rule ready-decision) in scripts/check-backlog-pr.test.ts failed once on verify-macos for PR #420, a PR that did not touch it, and passed on a rerun and on Linux.

```dipo
branch: "DIPO-377/check-backlog-pr-flake"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) scripts/check-backlog-pr.test.ts passes 30 runs in a row on macOS"
park:
  reason: "ambiguous-spec"
  from: "In Progress"
  note: "Can you send the verify-macos log of the failing run on PR #420 (the Backlog CLI output for the first test), or allow a macOS run of the 30-run loop before I choose a fix? Without it, I can't name the cause the PR must state."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The cause of the failure is named in the PR (timing, a temp path, git config or the Backlog CLI), and the test no longer depends on it
- [ ] #2 The test passes 30 runs in a row on macOS and on Linux
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-29: the same test ('passes a story made Ready', rule ready-decision) also failed on Linux verify for PR #423 (run 40846867414, attempt 1) and passed on a rerun, so the cause is not macOS-only. The test should pass 30 runs in a row on both.

Parked 2026-10-30 10:57 UTC: ambiguous-spec
- Detail: Can you send the verify-macos log of the failing run on PR #420 (the Backlog CLI output for the first test), or allow a macOS run of the 30-run loop before I choose a fix? Without it, I can't name th…
- Run: run_01M666Y0TK02BQ9TXAZ667ZB2Q
- Criteria met: 0 of 2 (as the worker reported them)
- Loops: 0 of 3; CI attempts: 0 of 2
- Review rounds: 0, failed 0 of 3
- Budget used: 112,585 of 300,000 tokens; 38 of 90 turns; 7 of 45 minutes
- Last good commit: 20a1148c9108f6b5b82c0eb02b554651c0460e94
<!-- SECTION:NOTES:END -->
