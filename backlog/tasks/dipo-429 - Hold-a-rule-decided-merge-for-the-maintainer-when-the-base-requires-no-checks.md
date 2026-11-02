---
id: DIPO-429
title: Hold a rule-decided merge for the maintainer when the base requires no checks
status: Refined
assignee: []
created_date: '2026-11-02 12:11'
updated_date: '2026-11-02 12:12'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/platform/host.ts
  - packages/engine/src/merge/stories.ts
  - packages/engine/src/run-state/gates.ts
  - packages/engine/test/merge/
  - packages/engine/test/platform/
priority: medium
type: bug
ordinal: 407000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a story never merges on the reviewer's verdict alone because the base branch has no required checks; dipo asks the maintainer and says why.

Found by the M1 close-out review of 2026-11-02 at main 01f38a19. `requiredCheckNames` returns an empty list when the base requires none (packages/engine/src/platform/host.ts about lines 111 and 143), and a gate decided by rule then turns on auto-merge (merge/stories.ts about lines 8-12), which GitHub merges at once. 0002 calls CI the final gate.

Design: an empty required-check list is one more reason the merge gate waits for the maintainer, with that reason in the gate's summary; loading an office whose base requires no checks shows a notice once. 0002, 0016.

```dipo
branch: "DIPO-429/no-required-checks"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a merge gate with no required checks on the base waits for the maintainer instead of auto-merging, and the office load shows a notice"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A merge gate whose base requires no checks waits for the maintainer with the reason in its summary and never turns auto-merge on by rule, shown by a test
- [ ] #2 A base with required checks merges by rule as today, shown by the existing tests
- [ ] #3 Loading an office whose base requires no checks emits one notice, shown by a test
<!-- AC:END -->
