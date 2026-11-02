---
id: DIPO-429
title: Hold a rule-decided merge for the maintainer when the base requires no checks
status: In Review
assignee: []
created_date: '2026-11-02 12:11'
updated_date: '2026-11-02 12:50'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/story-pr/prs.ts
  - packages/engine/src/story-pr/checks.ts
  - packages/engine/src/run-state/gates.ts
  - packages/engine/src/platform/host.ts
  - packages/engine/test/story-pr/
priority: medium
type: bug
ordinal: 407000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a story never merges on the reviewer's verdict alone because the base branch requires no checks; dipo asks the maintainer and says why.

Found by the M1 close-out review of 2026-11-02 at main 01f38a19. The story PR poller reads the base's required checks in `#requiredNames` (packages/engine/src/story-pr/prs.ts about line 1053, with story-pr/checks.ts), through `requiredCheckNames` (platform/host.ts about lines 145 and 649). When the base requires none, the list is empty and a gate decided by rule turns on auto-merge, which GitHub merges at once (described in the header comment of merge/stories.ts). 0002 calls CI the final gate.

Design: only a successful read that returns no required checks counts. A failed read already returns null and waits, as today; no host wired (`required === undefined`, which today also yields an empty list) keeps today's behaviour, so tests and an office without a host are not held. For a successful empty read, the merge gate waits for the maintainer, with "the base requires no checks" in the gate's summary. The poller logs and emits one office notice the first time it reads an empty list for an office in a daemon run. 0002, 0016.

```dipo
branch: "DIPO-429/no-required-checks"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a merge gate whose base was read to require no checks waits for the maintainer instead of auto-merging, and the PR poller notes it once per office"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A merge gate whose base was read to require no checks waits for the maintainer with that reason in its summary and never turns auto-merge on by rule, shown by a test
- [x] #2 A failed read waits as today, no wired host behaves as today, and a base with required checks merges by rule as today, shown by tests
- [x] #3 The first empty read for an office in a daemon run emits one office notice and a log line, and later reads emit none, shown by a test
<!-- AC:END -->
