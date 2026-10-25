---
id: DIPO-337
title: Bring local bun test from about 90 s to under 60 s
status: Refined
assignee: []
created_date: '2026-10-24 09:32'
updated_date: '2026-10-25 09:55'
labels: []
milestone: m-2
dependencies:
  - DIPO-351
references:
  - packages/engine/test/
  - packages/daemon/
  - packages/testkit/src/
  - scripts/test.ts
priority: low
type: chore
ordinal: 318000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up of DIPO-225, which brought the local run from 385 s to about 91 s. Next steps: fast local versions of the tests that moved to CI without a local case (index-notify, clean-folder, park-commit), packages/daemon/src/hook.test.ts (5.4 s), and option (b) from DIPO-225 (run test files in parallel).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The sum of per-file durations of local bun test is under 60,000 ms, measured as in DIPO-225
- [ ] #2 Every rule a CI-only test checks has a fast local test
<!-- AC:END -->

## Comments

<!-- COMMENTS:BEGIN -->
created: 2026-10-25 09:55
---
Held on 2026-10-24 until the prune toward the simplified architecture ends (DIPO-351 and Track 2). The prune removes code and tests, so the test time is measured again after it.
---
<!-- COMMENTS:END -->
