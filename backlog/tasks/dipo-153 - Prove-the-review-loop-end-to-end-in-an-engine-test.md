---
id: DIPO-153
title: Prove the review loop end to end in an engine test
status: Done
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-23 11:20'
labels:
  - 'tier:M'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-150
  - DIPO-152
references:
  - '- packages/engine/test/engine/'
  - packages/engine/test/engine/loop-host.ts
  - packages/engine/test/engine/loop-office.ts
  - packages/engine/test/engine/review-loop.ci.test.ts
priority: high
type: task
ordinal: 142000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: one engine-layer test file with a scripted worker and reviewer, a fake host and real git covers approve, blocked then fixed, a security finding, red CI, a conflict, a maintainer gate, an override, a review next to a running worker and a daemon restart in the slot.

Context: proves ADR 0019 section 1 (the loop) across sections 3 to 13 at the engine layer, with the test rules of 0017 (temp files under DIPO_TMP, local bun test under about 60 seconds).

```dipo
branch: "DIPO-153/review-loop-engine-test"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) the scenario file passes: approve, blocked then fixed, security finding, red CI, conflict, maintainer gate, override, parallel review, restart in the slot"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 One test file under packages/engine/test/engine/ drives the engine with a scripted worker, a scripted reviewer, a fake code host and real git repositories under DIPO_TMP
- [x] #2 It covers approve and merge, blocked then fixed, a blocking security finding, red CI then green, a conflict hand-off, a merge gate the maintainer approves, an override of a review-blocked park and a review running next to a working developer session
- [x] #3 It covers a daemon restart while a story is in the merge slot, after which the slot continues with the same occupant and merges the PR once
- [x] #4 The file runs in the local bun test within the 60 second budget, or is named *.ci.test.ts when it cannot
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Done 2026-10-23 (maintainer session): built outside dipo, reviewed by a separate agent (all 4 criteria met). The test found two engine gaps, pinned with it.failing: the merge slot's conflict merge never reaches the story's box (DIPO-324 closes it) and the Done teardown waits for worker_hosts.ended_at, which only a re-attach sets (DIPO-328 closes it). The branch is DIPO-153/review-loop-e2e instead of the declared review-loop-engine-test.
<!-- SECTION:NOTES:END -->
