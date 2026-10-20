---
id: DIPO-183
title: Give the worker the base commit's known verify failures
status: Parked
assignee: []
created_date: '2026-10-17 17:24'
updated_date: '2026-10-20 18:52'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/run/
  - packages/engine/test/run/
  - packages/engine/src/prompts/
  - packages/engine/test/prompts/
  - packages/engine/src/sandbox/
  - packages/engine/test/sandbox/
  - packages/engine/src/worktree/
  - packages/engine/test/worktree/
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/src/retention/policy.ts
  - packages/engine/test/db/
priority: medium
type: feature
ordinal: 172000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker reads in its task message which verify failures the base commit already has in its sandbox, or that the base is green, so it never spends turns rebuilding a baseline to prove a failure is not its own.

Context: the first M1a run, DIPO-123 (run_01M55CQA2468N35QN7V2D5S9MY). The worker spent about 6 of its 46 turns building its own baseline to show that 10 sandbox-only test failures were not caused by its change: `git archive HEAD | tar -x` into $TMPDIR/base-head, then several tries to link node_modules, the missing workspace links and zod. dipo runs verify only when the worker reports done, on the branch, through the sandboxed verify step (packages/engine/src/run/verify-commit.ts). That step's policy has no home-wide read block (packages/engine/src/sandbox/policy.ts), so its green result does not say what fails in the worker's sandbox. The task message is assembled in packages/engine/src/prompts/ (the sections of 0014 section 2, templates in packages/engine/src/prompts/task/), and L1 (packages/engine/src/prompts/contract/implement.md) lists the sections. A new section changes the 0014 section 2 table, and the 0014 section 2 note of 2026-10-20 (DIPO-183) adds the base_verify section; this story does not edit docs/decisions/.

Verify needs an installed checkout of the base commit. The `_base` read worktree (ensureBaseWorktree in packages/engine/src/git/office.ts) has no install. A story worktree is one right after setup (packages/engine/src/worktree/setup.ts runs the install), before the worker changes anything, but running verify there delays the worker's start on each new base by one verify. The maintainer chose it on 2026-10-20: the base verify runs in the story worktree after setup, before the worker starts, and only the first run on a new base pays the extra verify. Once per base commit and office config hash, the engine would run the base verify under a step policy with the worker's read fence, store whether it passed and which tests failed (bun's `(fail)` lines, or the output tail when the runner is not recognised), and render that as a `base_verify` section. Relation to DIPO-176: once the full suite passes in the worker sandbox, the list is empty on this repository, but a flaky test or a base that is red for another reason still gets named, and other offices gain the same.

```dipo
branch: "DIPO-183/base-verify-failures-for-worker"
unknowns:
  - q: "Where does the base verify run: in the story worktree after setup and before the worker starts (an installed checkout of the base commit, at the cost of delaying the first run on each new base by one verify), or in a separate installed checkout per office base, since the _base read worktree has no install?"
    status: "resolved"
    answer: "A (maintainer, 2026-10-20): in the story worktree after setup and before the worker starts, on the base commit, with the result cached per base commit, so only the first run on a new base pays one extra verify."
  - q: "0014 section 2 lists the sections of the task message. The maintainer records a dated 0014 section 2 note that adds the base_verify section before this story goes Ready."
    status: "resolved"
    answer: "A (maintainer, 2026-10-20): approved; the 0014 section 2 note of 2026-10-20 (DIPO-183) says the task message gains a base_verify section listing the base commit's known verify failures, empty when the base is green."
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a first run on a new base runs the base verify in the story worktree after setup and before the worker starts, and a second run on the same base commit and office config reuses the stored result without running verify"
    - kind: "automated"
      check: "(unit) a base with two failing tests gives a section naming both, a green base gives the green line, and an unknown result gives the not-known line, in the first session and the handoff message, and the golden files match"
    - kind: "automated"
      check: "(unit) a base verify that cannot run, and a worktree not at its base commit with no stored result for that base, give the not-known line and the run still starts"
    - kind: "automated"
      check: "(unit) a fresh and a migrated database have the same base verify table, and TABLE_RETENTION lists it"
    - kind: "manual"
      check: "(live) on this repository, run a story while tests still fail on main inside the worker sandbox"
      expect: "the task message lists those tests, and the worker builds no baseline of its own"
park:
  reason: "stopped"
  from: "In Review"
  note: "dipo's reviewer self-test fails (bun not on the reviewer's PATH) and retries every ~70 s; stopped to end the loop, reviewed by hand"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 For the base commit a run starts from, the engine runs the office's verify in the story worktree right after setup and before the worker starts, while that worktree is at the base commit, under the worker's sandbox read fence, and stores the result: green, or the failing test names with the output tail when no names can be read; it runs once per base commit and office config hash, and later runs on the same base reuse the stored result without running verify
- [x] #2 The task message of a first session and of a handoff has a section that says the base is green, or lists the base's failing tests and says they fail on the base without this story's change; L1 lists the section and the golden files are updated
- [x] #3 A base verify that could not run, or a run whose worktree is not at its base commit after setup with no stored result for that base, gives the section's not-known line, and the run still starts
- [x] #4 The result is stored in an office-scoped table whose migration is registered in packages/engine/src/db/schema.ts, with a TABLE_RETENTION line in packages/engine/src/retention/policy.ts
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Hold lifted (maintainer, 2026-10-20, answer A: lift the hold, set Ready). The story had been on hold since 2026-10-18 while main's verify passed in the worker sandbox; the maintainer chose to deliver it so a red or flaky base is named to the worker.
<!-- SECTION:NOTES:END -->
