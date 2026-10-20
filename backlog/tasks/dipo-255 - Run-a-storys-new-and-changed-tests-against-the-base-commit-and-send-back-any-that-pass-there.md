---
id: DIPO-255
title: >-
  Run a story's new and changed tests against the base commit and send back any
  that pass there
status: Refined
assignee: []
created_date: '2026-10-20 20:20'
updated_date: '2026-10-20 20:25'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies:
  - DIPO-254
  - DIPO-228
references:
  - packages/engine/src/run/verify-commit.ts
  - packages/engine/src/worktree/base-verify.ts
  - packages/engine/src/sandbox/fence.ts
  - packages/engine/src/sandbox/step.ts
  - packages/engine/src/prompts/feedback.ts
  - packages/engine/src/prompts/feedback/
  - packages/engine/src/prompts/review.ts
  - packages/engine/test/run/verify-commit.test.ts
  - packages/engine/test/worktree/
  - packages/engine/test/prompts/
priority: high
type: feature
ordinal: 136400
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: after verify passes, the engine runs the story's new and changed test files against the base commit's code, and a new test that passes there goes back to the worker as feedback and is shown to the reviewer, so a test that proves nothing is caught before review.

Context: the maintainer's decision D3 of 2026-10-20 (answer A); dated 0014 section 7 note of 2026-10-20. In the M1 runs reviewers found tests that passed with or without the fix (DIPO-229's "resume first" test, DIPO-201's claim path; docs/research/2026-10-20-dipo-run-gaps.md section 3.2). VerifyCommit (packages/engine/src/run/verify-commit.ts) runs the profile's verify through the sandboxed step runner (packages/engine/src/sandbox/step.ts) before it commits. DIPO-183 runs the base commit's verify in the story worktree after setup (packages/engine/src/worktree/base-verify.ts) under the worker's read fence (packages/engine/src/sandbox/fence.ts). Here the base's code runs with the branch's test files: a temp checkout of the base commit with the branch's new and changed test files copied in, reusing the story worktree's install. A test that fails on the base only because the code it calls does not exist yet counts as failing, which is the wanted result; a test whose fixtures the branch changed must be run with those fixtures too, so the changed fixture files are copied along. Feedback items are built in packages/engine/src/prompts/feedback.ts, and the review task message in packages/engine/src/prompts/review.ts.

```dipo
branch: "DIPO-255/new-tests-fail-on-base"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) verify-commit.test.ts: a branch whose new test passes on the base gets one feedback item naming the file and test, and no commit; a test that fails on the base passes the check"
    - kind: "automated"
      check: "(unit) a test file that imports a module the base does not have counts as failing on the base; a changed fixture file is copied with the test"
    - kind: "automated"
      check: "(unit) a base check that cannot run (no base commit, a timeout) does not block the commit and is named in the review task message"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 After the run's verify passes and before the commit, VerifyCommit lists the test files the branch adds or changes against the run's base commit, and, when there is at least one, runs them in a temp checkout of the base commit with those files and the branch's changed fixture files copied in, through the sandboxed step runner under the worker's read fence, reusing the story worktree's installed dependencies
- [ ] #2 Each new or changed test that passes on the base commit is sent back as one feedback item naming the file and the test, saying it passes without the change, and the commit waits; a test that fails on the base, also because the code it calls is missing there, passes this check
- [ ] #3 A base check that cannot run (no base commit, a failed checkout, a timeout) does not block the commit; it is logged at warn and named in the review task message, as is every test that passed on the base
- [ ] #4 Tests in packages/engine/test/run/verify-commit.test.ts and packages/engine/test/worktree/ cover a test that passes on the base, one that fails there, a missing import, a changed fixture and a base check that cannot run
<!-- AC:END -->
