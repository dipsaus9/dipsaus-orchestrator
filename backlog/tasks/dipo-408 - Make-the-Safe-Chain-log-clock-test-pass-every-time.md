---
id: DIPO-408
title: Make the Safe-Chain log clock test pass every time
status: Refined
assignee: []
created_date: '2026-10-31 09:39'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies: []
references:
  - packages/engine/test/box/safe-chain-log.test.ts
  - packages/engine/src/box/safe-chain.ts
priority: medium
type: bug
ordinal: 386000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: packages/engine/test/box/safe-chain-log.test.ts passes on every run, so a CI shard never fails on it by chance.

Seen 2026-10-31 on PR #505 (run 41187639776, attempt 3, verify-macos shard 4): the case "keeps every refusal as unknown when the box's clock cannot be read or moved during the session" (DIPO-396) failed once and passed on re-run, with no code change. The builder of DIPO-406 saw it depend on the system clock. Find the cause (real time read where the test means a fake clock, a mark taken across a second boundary, or the like), fix the test or the code, and say which. The refusal rule itself (a refusal not tied to one box stays unknown, 0008) must not weaken. 0002, 0008.

```dipo
branch: "DIPO-408/safe-chain-clock-flake"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) safe-chain-log.test.ts passes 50 runs in a row on the Mac, the clock case included"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The cause of the one-off failure is named in the PR, with a way to reproduce it (for example a fixed clock at the boundary that fails on main)
- [ ] #2 safe-chain-log.test.ts passes 50 runs in a row on the Mac after the fix, recorded in the PR
- [ ] #3 No case is removed or skipped, and a refusal that cannot be tied to one box still stays unknown, shown by the existing tests
<!-- AC:END -->
