---
id: DIPO-513
title: 'Make the real-host re-attach tests wait by time, not by poll count'
status: Done
assignee: []
created_date: '2026-11-10 14:23'
updated_date: '2026-11-26 09:45'
labels:
  - tech-debt
  - 'tier:S'
  - 'role:developer'
milestone: m-4
dependencies: []
references:
  - packages/engine/test/run/reattach.test.ts
modified_files:
  - packages/engine/test/run/reattach.test.ts
type: chore
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want the real worker host re-attach tests to pass on a busy machine and to say which wait ran out when they fail so that a red verify means a real failure.

Two tests start a real worker host whose launch deadline is REAL_HOST_DEADLINE_MS (4.5 s) away (packages/engine/test/run/reattach.test.ts:1432, realPendingHost at :1493-1528): the host that never binds (:1613-1636) and the host that fails the identity check (:1638-1678). The waits count polls, not time:
- realPendingHost waits for the socket for 400 polls of 10 ms (:1525).
- stoppedItself waits for the park for 800 polls of 10 ms (:1532), then for the host's exit for 300 polls of 20 ms (:1537).
Under load a sleep takes longer than asked, so the poll counts and the 14.5 s test timeout (:1437) do not match. A failed expect does not say which wait ran out. These tests failed verify on stories that never touched the host.

- One wait helper polls until a time on systemClock: the socket until the deadline, the park until the deadline plus a named grace, and the exit until the park plus a named grace.
- When a wait runs out, the helper fails with a message naming the wait and how long it waited.
- The test timeout is the deadline plus the sum of the graces and a margin, named once.

## What it does not do
- Does not change the worker host's launch deadline or how the daemon claims a host.
- Does not touch the fake-host tests in the same file.

## ADR lines that change
None.

## Risks and choices
None.

```dipo
branch: "DIPO-513/make-real-host-re-attach-tests-wait-by"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "The wait helper with a condition that never holds fails after its time with a message naming the wait"
    - kind: "automated"
      check: "The never-binds and identity-check real-host tests pass in verify"
    - kind: "manual"
      check: "Run packages/engine/test/run/reattach.test.ts ten times while a full bun test runs alongside"
      expect: "All ten runs pass, or a failure names the wait that ran out"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 realPendingHost and stoppedItself wait on elapsed time from systemClock, with no fixed poll counts.
- [x] #2 When the socket, park or exit wait runs out, the failure message names that wait and the milliseconds it waited.
- [x] #3 The never-binds and identity-check tests both use the same helpers.
- [x] #4 The tests' timeout is computed from the deadline and the named graces, so it is longer than all the waits added together.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-26 09:45 UTC
- Criteria met: 4 of 4 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 1, failed 0
- Budget used: 29,305 of 300,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 0
<!-- SECTION:FINAL_SUMMARY:END -->
