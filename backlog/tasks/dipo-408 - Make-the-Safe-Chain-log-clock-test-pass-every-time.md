---
id: DIPO-408
title: Make the Safe-Chain log clock test pass every time
status: In Review
assignee: []
created_date: '2026-10-31 09:39'
updated_date: '2026-10-31 10:28'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies: []
references:
  - packages/engine/test/box/safe-chain-log.test.ts
  - packages/engine/src/box/safe-chain.ts
  - packages/engine/src/box/safe-chain-box.ts
priority: medium
type: bug
ordinal: 386000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: packages/engine/test/box/safe-chain-log.test.ts passes on every run, so a CI shard never fails on it by chance.

Seen 2026-10-31 on PR #505 (run 41187639776, attempt 3, verify-macos shard 4): the case "keeps every refusal as unknown when the box's clock cannot be read or moved during the session" (DIPO-396) failed once and passed on re-run, with no code change. The builder of DIPO-406 saw it depend on the system clock. Find the cause (real time read where the test means a fake clock, a mark taken across a second boundary, or the like), fix the test or the code, and say which. A likely cause (a light review, not run): ROUTE_CHECK in the test is built at module load, so its log lines carry a time from before the mark, by however long a loaded shard took to reach the case, on top of the real `date` window and the 500 ms drift (SAFE_CHAIN_CLOCK_DRIFT_MS). The refusal rule itself (a refusal not tied to one box stays unknown, 0008) must not weaken. 0002, 0008.

```dipo
branch: "DIPO-408/safe-chain-clock-flake"
unknowns:
  - q: "Can someone run `bun test packages/engine/test/box/safe-chain-log.test.ts` 50 times in a row on the Mac and record the result on the PR? That is the only part of criterion 2 left, and this box cannot run it."
    status: "resolved"
    answer: "Run the file 50 times in a row in the box instead and record that result in the PR body; that meets criterion 2 for you. The maintainer's session runs the 50 Mac runs against the PR's head after it opens and adds them as a comment. Go on and open the PR."
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) safe-chain-log.test.ts passes 50 runs in a row on the Mac, the clock case included"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The cause of the one-off failure is named in the PR, with a test that forces it and fails on main (for example a fixed clock at the boundary, or the delay that causes it)
- [ ] #2 safe-chain-log.test.ts passes 50 runs in a row on the Mac after the fix, recorded in the PR
- [x] #3 No case is removed or skipped, and a refusal that cannot be tied to one box still stays unknown, shown by the existing tests
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parked 2026-10-31 10:22 UTC: ambiguous-spec
- Detail: Can someone run `bun test packages/engine/test/box/safe-chain-log.test.ts` 50 times in a row on the Mac and record the result on the PR? That is the only part of criterion 2 left, and this box cannot…
- Run: run_01M68QN7MA1EJHVXRPP2ENS8DZ
- Criteria met: 2 of 3 (as the worker reported them)
- Loops: 0 of 3; CI attempts: 0 of 2
- Review rounds: 0, failed 0 of 3
- Budget used: 49,939 of 300,000 tokens; 14 of 90 turns; 1 of 45 minutes
- Last good commit: 2b5d459e0f6a7a68b035744d559fccc4efc9194a

Resumed 2026-10-31 10:23 UTC; grants: none; note: Run the file 50 times in a row in the box instead and record that result in the PR body; that meets criterion 2 for you. The maintainer's session runs the 50 Mac runs against the PR's head after it o…
<!-- SECTION:NOTES:END -->
