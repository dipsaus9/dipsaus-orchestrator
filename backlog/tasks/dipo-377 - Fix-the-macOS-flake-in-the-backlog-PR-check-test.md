---
id: DIPO-377
title: Fix the flake in the backlog PR check test
status: In Progress
assignee: []
created_date: '2026-10-29 09:29'
updated_date: '2026-10-30 11:10'
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
unknowns:
  - q: "Can you send the verify-macos log of the failing run on PR #420 (the Backlog CLI output for the first test), or allow a macOS run of the 30-run loop before I choose a fix? Without it, I can't name the cause the PR must state."
    status: "resolved"
    answer: "Both failing logs show the same thing. Linux, PR #423 (run 40846867414 attempt 1) and macOS, PR #420 (run 40841772142 attempt 1, verify-macos): scripts/check-backlog-pr.test.ts:103, 'passes a story made Ready that passes the Ready gate, and leaves no worktree', result.failures was [{ key: DIPO-1, rule: ready-decision, task: DIPO-1, message: 'DIPO-1 becomes Ready without a passing Ready gate decision for its content; run ready DIPO-1 again' }] instead of []. So on both systems the Ready gate decision for the head did not pass, which fits what you found: under load the Backlog CLI's listing in a fresh fixture is empty or shows another fixture's tasks. Name that as the cause (with your reproduction), fix it so each fixture's Backlog CLI calls are isolated from the others (find the shared state: cache, HOME, a temp path or config the CLI reads), and prove it with your stress loop on Linux in the box. For macOS: do not build a runner; after you push, the orchestrating session runs your 30-run loop on the Mac on your branch and records the result on the PR. Put the exact loop command in the PR body."
  - q: "Fixed the flake in the test fixture, not the engine. Cause: the Backlog CLI rewrites backlog/config.yml on its first read when the file lacks its defaults (max_column_width, auto_open_browser, default_port, bypass_git_hooks, active_branch_days). listAll runs `task list --plain` and `--count` at once, so under load one of them can read the file half-written and see no tasks; the retry can hit the same window. The Ready gate then checks 0 stories and the test reports ready-decision for DIPO-1. The fix: pr() in scripts/check-backlog-pr.test.ts runs one Backlog read on the fixture before the base commit, so the committed config is already normalized and no concurrent read rewrites it. Ruled out: a shared HOME between fixtures. Passing the fixture's HOME to the CLI still gave 2/96 failures. Verified: the baseline stress loop gave 3/96 failures; after the fix, 0/96 (8 parallel x 12) and 0/96 (16 parallel x 6), 30 of 30 sequential runs passed, and `bun run verify` passed. The part is delivered to dipo. Not done: the macOS evidence. This box is Linux, so the 30-run check on macOS is for verify-macos on the PR."
    status: "resolved"
    answer: "The fix and the Linux evidence are enough to go to review. The macOS 30-run check is done by the orchestrating session on the Mac against the pushed head and recorded on the PR; criterion 2's macOS part is checked there, not in the box. Finish the done report and push for review."
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) scripts/check-backlog-pr.test.ts passes 30 runs in a row on macOS"
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

Resumed 2026-10-30 10:58 UTC; grants: none; note: Both failing logs show the same thing. Linux, PR #423 (run 40846867414 attempt 1) and macOS, PR #420 (run 40841772142 attempt 1, verify-macos): scripts/check-backlog-pr.test.ts:103, 'passes a story m…

Parked 2026-10-30 11:09 UTC: ambiguous-spec
- Detail: Fixed the flake in the test fixture, not the engine. Cause: the Backlog CLI rewrites backlog/config.yml on its first read when the file lacks its defaults (max_column_width, auto_open_browser, defaul…
- Run: run_01M666Y0TK02BQ9TXAZ667ZB2Q
- Criteria met: 1 of 2 (as the worker reported them)
- Loops: 0 of 3; CI attempts: 0 of 2
- Review rounds: 0, failed 0 of 3
- Budget used: 190,832 of 300,000 tokens; 76 of 90 turns; 18 of 45 minutes
- Last good commit: be805ec42f8884b5db6b3069132bb364aa2b9f72

Resumed 2026-10-30 11:10 UTC; grants: none; note: The fix and the Linux evidence are enough to go to review. The macOS 30-run check is done by the orchestrating session on the Mac against the pushed head and recorded on the PR; criterion 2's macOS p…
<!-- SECTION:NOTES:END -->
