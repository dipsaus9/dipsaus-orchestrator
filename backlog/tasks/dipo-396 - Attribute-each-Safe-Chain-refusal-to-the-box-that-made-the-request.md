---
id: DIPO-396
title: Attribute each Safe-Chain refusal to the box that made the request
status: Done
assignee: []
created_date: '2026-10-30 16:01'
updated_date: '2026-10-31 08:07'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-376
references:
  - packages/engine/src/box/safe-chain-box.ts
  - packages/engine/src/box/safe-chain.ts
  - packages/engine/src/box/workers.ts
  - packages/engine/src/box/web-proxy.ts
  - packages/engine/src/create/runs.ts
  - packages/engine/test/box/
priority: medium
type: bug
ordinal: 374000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a Safe-Chain refusal is stored only on the run whose box made the refused request, so overlapping sessions of different runs and offices never see each other's refusals.

Gap G12, found by the review of PR #463 (DIPO-376): one BoxWorkers and one web route serve every loaded office (create/runs.ts, box/workers.ts), and Safe-Chain's log does not say which box asked, so a refusal is stored on every run whose session was open at the time, across offices too (0007 keeps state per office). Impact is low (public package names, extra refused lines), but it is wrong data in a run row. Fix idea: the web proxy knows the client box of each tunnel; pass that through to Safe-Chain (a port per box, or a header or log field Safe-Chain records), or attribute in the web proxy instead of reading Safe-Chain's log. 0008, 0007.

```dipo
branch: "DIPO-396/safe-chain-refusal-per-box"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(box) two runs with overlapping sessions: each run row holds only its own box's refusals"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Each stored refusal names the run whose box made the refused request; a refusal is never stored on a run whose box did not make it
- [x] #2 A fake-box test and a real-box test (DIPO_TEST_BOX=1) with two boxes of two runs whose sessions overlap, each installing a different refused package, show each run row holds only its own refusal
- [x] #3 A refusal whose box cannot be told is recorded as unknown on the runs that were open, never as a refusal of one of them
- [x] #4 What DIPO-376 caught still holds, each with a test: the per-session diff of the log, each package once, unknown when a log is unreadable, cut or timed out
- [x] #5 Bypass forms are tested: a tunnel with a wrong, stale or missing proxy password, a host or alias that skips the Safe-Chain route, and the same package refused for two boxes
- [x] #6 Fail-closed: the change moves only where a refusal is recorded; Safe-Chain still refuses the package and the install still fails, shown against the real path; the escape probe runs again if the Safe-Chain image or the box network changes (0008)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A Safe-Chain refusal is now stored only on the run whose box made the request. The web proxy records each registry tunnel it sends to Safe-Chain with its admitted box (from the proxy password), ecosystem and open and close times; the session marks and reads measure the Safe-Chain box clock against the Macs; a refusal goes to a run only when that runs box was the only client with a tunnel of that ecosystem open at the time, is left out when another single box was, and is stored as unknown, naming no package, in every other case, including clock drift over 500 ms, a refusal outside the sessions window, and log lines that cannot be paired with one full package name (scope included). The refusal itself and the install failure are unchanged; the Safe-Chain image and the box network did not change, so the escape probe was not due. Known limit: a refusal for a reviewer box, a test box, an install step, or a run between its admit and its mark is recorded on no run.
<!-- SECTION:FINAL_SUMMARY:END -->
