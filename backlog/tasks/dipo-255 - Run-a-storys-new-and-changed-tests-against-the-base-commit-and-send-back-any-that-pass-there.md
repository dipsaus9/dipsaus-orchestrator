---
id: DIPO-255
title: >-
  Run a story's new and changed tests against the base commit and send back any
  that pass there
status: To Do
assignee: []
created_date: '2026-10-20 20:20'
updated_date: '2026-10-22 08:32'
labels:
  - 'tier:M'
  - cutover
  - needs-info
  - needs-refinement
milestone: m-1
dependencies:
  - DIPO-254
  - DIPO-228
  - DIPO-291
  - DIPO-293
  - DIPO-294
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
  - packages/engine/src/run/story-git.ts
  - packages/engine/src/git/office.ts
  - packages/engine/test/git/office-git.test.ts
priority: high
type: feature
ordinal: 136400
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: after verify passes, the engine runs the story's new and changed test files against the base commit's code, and a new test that passes there goes back to the worker as feedback and is shown to the reviewer, so a test that proves nothing is caught before review.

Context: the maintainer's decision D3 of 2026-10-20 (answer A); dated 0014 section 7 note of 2026-10-20. The checkout mechanism and copying the branch's changed fixture files with the tests are this story's design choices (design choice, not a maintainer decision; the maintainer may change it before a run). In the M1 runs reviewers found tests that passed with or without the fix (DIPO-229's "resume first" test, DIPO-201's claim path; docs/research/2026-10-20-dipo-run-gaps.md section 3.2). VerifyCommit (packages/engine/src/run/verify-commit.ts) runs the profile's verify through the sandboxed step runner (packages/engine/src/sandbox/step.ts) before it commits. DIPO-183 runs the base commit's verify in the story worktree after setup (packages/engine/src/worktree/base-verify.ts) under the worker's read fence (packages/engine/src/sandbox/fence.ts). Here the base's code runs with the branch's test files: a temp checkout of the base commit outside the story worktree, made through a new StoryGit method (packages/engine/src/run/story-git.ts) backed by the office git (packages/engine/src/git/office.ts, which already makes the _base read worktree), with the branch's new and changed test files copied in, reusing the story worktree's install, and removed afterwards. Its gitdir pointer and the tamper checks of the claim and the done path (packages/engine/src/worktree/claim.ts, packages/engine/src/worktree/done.ts) must still hold for the story worktree. A test that fails on the base only because the code it calls does not exist yet counts as failing, which is the wanted result; a test whose fixtures the branch changed must be run with those fixtures too, so the changed fixture files are copied along. Feedback items are built in packages/engine/src/prompts/feedback.ts, and the review task message in packages/engine/src/prompts/review.ts.

```dipo
branch: "DIPO-255/new-tests-fail-on-base"
unknowns:
  - q: "When the base check cannot run (no base commit, a failed checkout, a timeout), what happens to the commit? (a) it goes on: the failure is logged at warn and named in the review task message (recommended: verify already passed, and a broken check should not hold up finished work); (b) the commit waits and the worker gets a feedback item, as for a test that passes on the base."
    status: "open"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) verify-commit.test.ts: a branch whose new test passes on the base gets one feedback item naming the file and test, and no commit; a test that fails on the base passes the check"
    - kind: "automated"
      check: "(unit) a test file that imports a module the base does not have counts as failing on the base; a changed fixture file is copied with the test"
    - kind: "automated"
      check: "(unit) a base check that cannot run (no base commit, a timeout) behaves as the unknown's answer picks, and is named in the review task message"
    - kind: "automated"
      check: "(unit) StoryGit's base checkout is made outside the story worktree, removed afterwards also on a failure, and leaves the story worktree's gitdir pointer unchanged"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 After the run's verify passes and before the commit, VerifyCommit lists the test files the branch adds or changes against the run's base commit, and, when there is at least one, runs them in a temp checkout of the base commit made outside the story worktree through a StoryGit method backed by packages/engine/src/git/office.ts and removed afterwards, with those files and the branch's changed fixture files copied in (design choice, not a maintainer decision; the maintainer may change it before a run), through the sandboxed step runner under the worker's read fence, reusing the story worktree's installed dependencies
- [ ] #2 Each new or changed test that passes on the base commit is sent back as one feedback item naming the file and the test, saying it passes without the change, and the commit waits; a test that fails on the base, also because the code it calls is missing there, passes this check
- [ ] #3 As the unknown's answer picks, a base check that cannot run (no base commit, a failed checkout, a timeout) lets the commit go on with a warn line and its name in the review task message, or makes the commit wait with a feedback item to the worker; every test that passed on the base is named in the review task message
- [ ] #4 Tests in packages/engine/test/run/verify-commit.test.ts, packages/engine/test/git/office-git.test.ts and packages/engine/test/worktree/ cover the checkout and its removal, a test that passes on the base, one that fails there, a missing import, a changed fixture and a base check that cannot run
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: the base-commit test run happens in a box (0021 section 9).
<!-- SECTION:NOTES:END -->
