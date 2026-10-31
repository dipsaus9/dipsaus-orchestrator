---
id: DIPO-407
title: Run the review loop test's cases side by side
status: Done
assignee: []
created_date: '2026-10-31 08:39'
updated_date: '2026-10-31 10:19'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies: []
references:
  - packages/engine/test/engine/review-loop.ci.test.ts
  - packages/testkit/src/
priority: high
type: chore
ordinal: 385000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: review-loop.ci.test.ts runs in seconds instead of minutes.

Measured 2026-10-31 on verify-macos: packages/engine/test/engine/review-loop.ci.test.ts took 150 s, ten cases of 10 to 18 s each (a review next to a working session, a conflict hand-off, park and resume, a blocking security finding, red CI then green, and more), most of it real waiting. 0002.

Measured again 2026-10-31, it is not waiting: the file already runs on the manual clock, each case runs only 3 to 8 polls with at most 131 ms of sleep, and its time is about 55 Backlog CLI calls (about 80 ms each) and 240 git calls per case from production paths (packages/engine/src/backlog/fields/write.ts via backlog/story-copy.ts, run/work-run.ts, worktree/claim.ts and merge/close-out.ts; backlog/read.ts via stories/read.ts; backlog/list.ts via run/work-run.ts). A test clock cannot help, so the cases run side by side.

```dipo
branch: "DIPO-407/review-loop-test-clock"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) review-loop.ci.test.ts runs its cases side by side in under 20 s on the maintainer's Mac"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The cases of review-loop.ci.test.ts run concurrently, each with its own office, temp folders, remote and the manual clock it already uses; no case is removed or skipped and every assertion is kept
- [x] #2 The file takes under 20 s on the maintainer's Mac and passes 10 runs in a row locally; its macOS CI time is measured before and after and recorded in the PR
- [x] #3 Each case still fails when its behaviour breaks, shown for at least two cases by a temporary break in the PR description
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The twelve review-loop cases run side by side (describe.concurrent); the only shared state, a module-level request id counter, moved into each world. The file went from 96.7 s to about 17.5 s on the Mac (10 runs in a row pass) and from about 130 s to about 104 s on the 3-core macOS CI runner, where the subprocess-bound cases queue for CPU. The time is about 55 Backlog CLI and 240 git calls per case from production paths, not waiting; the test already ran on a manual clock. Criterion 2's CI half was relaxed by the orchestrating session from at most half to measured and recorded. Two temporary breaks failed three cases.
<!-- SECTION:FINAL_SUMMARY:END -->
