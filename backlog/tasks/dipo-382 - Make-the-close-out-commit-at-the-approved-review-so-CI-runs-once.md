---
id: DIPO-382
title: 'Make the close-out commit at the approved review, so CI runs once'
status: Refined
assignee: []
created_date: '2026-10-30 08:10'
updated_date: '2026-10-30 08:12'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/merge/close-out.ts
  - packages/engine/src/merge/gates.ts
  - packages/engine/src/merge/stories.ts
  - packages/engine/src/merge/merger.ts
  - packages/engine/src/run/fix-rounds.ts
  - packages/engine/src/story-pr/
  - docs/decisions/0002-review-and-testing.md
  - docs/decisions/0012-backlog-workflow.md
priority: high
type: enhancement
ordinal: 362000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a dipo story waits for CI once. dipo makes the close-out commit as soon as the review approves the head, and the required checks run once, on the close-out head, before the merge.

Measured on PRs #447 and #449 (2026-10-29 and 2026-10-30): the worker pushes the In Review head, the review approves it within about 2 minutes, then dipo waits about 16 minutes for CI on that head, pushes the close-out commit (final summary and status Done), and CI runs about 16 minutes again on a commit that changes only the task file. About 30 of the 35 to 45 minutes from Ready to merged are CI, half of it repeated. ci.yml cancels an in-progress run on a new push to the same PR, so closing out right after the verdict costs nothing. 0002 already says dipo makes the close-out commit and asks GitHub to merge when green; this removes the wait for green before the close-out. Maintainer's choice of 2026-10-30. 0002, 0012, 0020.

```dipo
branch: "DIPO-382/close-out-at-the-verdict"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) an approved verdict leads to the close-out commit without waiting for checks, and a red check on the close-out head starts a fix round"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 On the by-rule path (auto-merge on, no hold label, no maintainer criterion, no override, no test before merge, not the release path), the merge gate opens on the approved verdict for the current head without waiting for its checks; dipo then commits the close-out (final summary and status Done) and enables auto-merge, and GitHub merges only when the required checks pass on the close-out head
- [ ] #2 On every path where the gate waits for the maintainer (dipo approve, test before merge, a maintainer criterion, an override, a hold label, the release path and autorelease: pending PRs) the order stays as today: green checks on the head, then the maintainer, then the close-out; no task file reads Done on a PR that waits for the maintainer, shown by a test per path
- [ ] #3 A red or failed check on the close-out head turns auto-merge off and starts a fix round that writes status In Progress (fix-rounds.ts), and the next close-out replaces the earlier final summary; shown by a test with the engine fakes
- [ ] #4 The final summary is built from the facts known at close-out; the CI-attempts line and the verify-failing tier cap say they count the checks of reviewed and close-out heads as they now run
- [ ] #5 0002 (the review step that runs while CI runs, the merge gate, the required checks before the gate, the close-out) and 0012 (the In Review to In Progress row after a red check on a closed-out head) describe the two paths, each sentence rewritten in the same PR with a Replaced line; the maintainer chose this on 2026-10-30
- [ ] #6 A test with the engine fakes shows the by-rule order: verdict, close-out commit, auto-merge, one wait for checks, merge
<!-- AC:END -->
