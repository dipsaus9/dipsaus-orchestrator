---
id: DIPO-183
title: Give the worker the base commit's known verify failures
status: Refined
assignee: []
created_date: '2026-10-17 17:24'
updated_date: '2026-10-18 09:32'
labels:
  - 'tier:M'
  - cutover
  - on-hold
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
  - docs/decisions/0014-worker-prompt-assembly.md
priority: medium
type: feature
ordinal: 172000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker reads in its task message which verify failures the base commit already has in its sandbox, or that the base is green, so it never spends turns rebuilding a baseline to prove a failure is not its own.

Context: the first M1a run, DIPO-123 (run_01M55CQA2468N35QN7V2D5S9MY). The worker spent about 6 of its 46 turns building its own baseline to show that 10 sandbox-only test failures were not caused by its change: `git archive HEAD | tar -x` into $TMPDIR/base-head, then several tries to link node_modules, the missing workspace links and zod. dipo runs verify only when the worker reports done, on the branch, through the sandboxed verify step (packages/engine/src/run/verify-commit.ts). That step's policy has no home-wide read block (packages/engine/src/sandbox/policy.ts), so its green result does not say what fails in the worker's sandbox. The task message is assembled in packages/engine/src/prompts/ (the sections of 0014 section 2, templates in packages/engine/src/prompts/task/), and L1 (packages/engine/src/prompts/contract/implement.md) lists the sections. A new section changes the 0014 section 2 table, so the PR proposes a dated 0014 note for the maintainer's approval.

Verify needs an installed checkout of the base commit. The `_base` read worktree (ensureBaseWorktree in packages/engine/src/git/office.ts) has no install. A story worktree is one right after setup (packages/engine/src/worktree/setup.ts runs the install), before the worker changes anything, but running verify there delays the worker's start on each new base by one verify. That trade-off is the open unknown. Once per base commit and office config hash, the engine would run the base verify under a step policy with the worker's read fence, store whether it passed and which tests failed (bun's `(fail)` lines, or the output tail when the runner is not recognised), and render that as a `base_verify` section. Relation to DIPO-176: once the full suite passes in the worker sandbox, the list is empty on this repository, but a flaky test or a base that is red for another reason still gets named, and other offices gain the same.

```dipo
branch: "DIPO-183/base-verify-failures-for-worker"
unknowns:
  - q: "Where does the base verify run: in the story worktree after setup and before the worker starts (an installed checkout of the base commit, at the cost of delaying the first run on each new base by one verify), or in a separate installed checkout per office base, since the _base read worktree has no install?"
    status: "open"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a base with two failing tests gives a section naming both, a green base gives the green line, and an unknown result gives the not-known line"
    - kind: "automated"
      check: "(engine) two runs on the same base commit and office config run the base verify once"
    - kind: "manual"
      check: "(live) on this repository, run a story while tests still fail on main inside the worker sandbox"
      expect: "the task message lists those tests, and the worker builds no baseline of its own"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 For the base commit a run starts from, the engine has the result of the office's verify on an installed checkout of that commit, in the place the open unknown settles, under the worker's sandbox read fence: green, or the failing test names with the output tail when no names can be read; it is computed once per base commit and office config hash and reused by later runs
- [ ] #2 The task message of a first session and of a handoff has a section that says the base is green, or lists the base's failing tests and says they fail on the base without this story's change; L1 lists the section and the golden files are updated
- [ ] #3 A base verify that could not run, or a result that is not ready when the worker starts, gives the section's not-known line, and the run still starts
- [ ] #4 The result is stored in an office-scoped table whose migration is registered in packages/engine/src/db/schema.ts, with a TABLE_RETENTION line in packages/engine/src/retention/policy.ts
- [ ] #5 The PR proposes a dated note for docs/decisions/0014-worker-prompt-assembly.md section 2 that adds the section, for the maintainer's approval
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
On hold (maintainer, 2026-10-18). Main is green, and since DIPO-176 the full verify also passes in the worker sandbox; the false failures seen since came from workers overriding DIPO_TMP (DIPO-194). Pick this story up only if a base commit's verify fails again inside the sandbox while it passes outside; otherwise drop it.
<!-- SECTION:NOTES:END -->
