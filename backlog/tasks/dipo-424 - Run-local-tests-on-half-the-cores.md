---
id: DIPO-424
title: Run local tests on half the cores
status: Done
assignee: []
created_date: '2026-11-02 10:16'
updated_date: '2026-11-02 11:02'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - scripts/test.ts
  - scripts/test.test.ts
modified_files:
  - scripts/test.test.ts
  - scripts/test.ts
priority: medium
type: chore
ordinal: 402000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a local `bun run verify` leaves half the Mac's cores free, so the maintainer's machine stays usable while a builder or dipo verifies.

Since DIPO-337 (#547) `shardCount` in scripts/test.ts starts one `bun test` per core (14 on the maintainer's Mac). With two builders verifying at once on 2026-11-02 the load average reached 24 and the maintainer's Mac became slow. DIPO-337 measured 14 shards of 14-23 s each and a verify of about 24 s, so half the cores keeps verify well under the 60 s of 0017.

Design: `shardCount` returns half the cores, rounded down, at least 2. The same split by `splitShards`; nothing else changes (0001). 0017.

```dipo
branch: "DIPO-424/half-core-shards"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(scripts) bun run test starts half as many shards as the machine has cores, at least 2"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `shardCount` returns half the cores rounded down, at least 2 (14 cores: 7; 3 cores: 2), shown by a test in scripts/test.test.ts
- [x] #2 Every test file still runs exactly once and a failing shard still fails the run, shown by the existing tests
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-02 11:02 UTC
- Criteria met: 2 of 2 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 1, failed 0
- Budget used: 23,978 of 300,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 0
<!-- SECTION:FINAL_SUMMARY:END -->
