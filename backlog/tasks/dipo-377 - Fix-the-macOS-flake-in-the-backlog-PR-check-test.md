---
id: DIPO-377
title: Fix the macOS flake in the backlog PR check test
status: Refined
assignee: []
created_date: '2026-10-29 09:29'
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
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The cause of the failure is named in the PR (timing, a temp path, git config or the Backlog CLI), and the test no longer depends on it
- [ ] #2 The test passes 30 runs in a row on macOS
<!-- AC:END -->
