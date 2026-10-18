---
id: DIPO-189
title: Tell the worker how to read its branch when git branch is denied
status: Done
assignee: []
created_date: '2026-10-17 20:30'
updated_date: '2026-10-18 08:00'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/prompts/contract/implement.md
  - packages/engine/test/prompts/
  - packages/engine/src/workers/claude-cli/plan.ts
  - packages/engine/test/workers/plan.test.ts
priority: medium
type: bug
ordinal: 178000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker that needs its current branch runs a read-only command the run settings allow, instead of losing turns to denied git branch calls.

Context: the fourth M1a run, DIPO-176 (run_01M55PE8B6W4X9TMJEW2SYV7B6). The worker ran git branch --show-current, which the run settings denied, and then two compound commands that held it, also denied; it lost three tries finding its branch. The run settings deny Bash(git branch) and Bash(git branch *) because branch is in GIT_WRITE_VERBS (packages/engine/src/workers/claude-cli/plan.ts): git branch <name> and git branch -d write. In Claude Code a deny rule beats an allow rule, so git branch --show-current cannot be allowed next to the broad rule, and a deny list cannot name every writing form of git branch. So branch creation and deletion stay denied. git rev-parse is not denied, and git rev-parse --abbrev-ref HEAD prints the branch. L1 says the worker may run "read-only git (git diff, git log, git status)", which a worker reads as including git branch.

Stating the branch in the task message was the other candidate. The <story> section holds id, title, type and tier (0014 section 2, row 6), so adding the branch there changes that table and needs an ADR amendment; this story leaves it out. L1 stays the same for every story with the same role (0014 section 5), so the new text names commands only.

```dipo
branch: "DIPO-189/worker-reads-its-branch"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(golden) the rendered system file says git branch is denied in every form and names git rev-parse --abbrev-ref HEAD"
    - kind: "automated"
      check: "(unit) the run settings deny git branch and git branch with arguments, and no deny rule starts with git rev-parse"
    - kind: "manual"
      check: "(live) on the scratch repo, run a story whose task needs the worker to name its current branch"
      expect: "the worker uses git rev-parse --abbrev-ref HEAD or git status, and the run has no denied git branch call"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 L1 (packages/engine/src/prompts/contract/implement.md) says git branch is denied in every form, also inside a compound command, and that git rev-parse --abbrev-ref HEAD or git status shows the current branch; the text names no run's branch, id or path, and packages/engine/test/prompts/golden/system-implement-developer.md is updated and its test passes
- [x] #2 The run settings from packages/engine/src/workers/claude-cli/plan.ts still deny Bash(git branch) and Bash(git branch *), and hold no deny rule that starts with Bash(git rev-parse); a test in packages/engine/test/workers/plan.test.ts asserts both
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M5704NRKJKZDD0DMWXQBCV2N (Haiku low, 13 turns, about $0.01, 2 min) reported done, both criteria, In Review on DIPO-189/worker-reads-its-branch, with no denied call. Verify outside the sandbox on DIPO-189/worker-reads-its-branch-finish (origin/main merged in): 0 fail. Review passed with no changes. The live scratch-repo check of the test plan (a worker names its branch with no denied git branch call) is left for the maintainer's hand-test session.
<!-- SECTION:NOTES:END -->
