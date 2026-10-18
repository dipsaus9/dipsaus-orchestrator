---
id: DIPO-204
title: Deny git write verbs after git's global options in the worker run settings
status: Refined
assignee: []
created_date: '2026-10-18 09:10'
updated_date: '2026-10-18 09:10'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/workers/claude-cli/plan.ts
  - packages/engine/test/workers/plan.test.ts
  - packages/engine/test/workers/golden/
priority: medium
type: bug
ordinal: 193000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the worker's run settings deny the git write verbs also when a global option such as -C comes before the verb, so `git -C . commit` is denied like `git commit`.

Context: review of DIPO-192 (PR #202). permissions() in packages/engine/src/workers/claude-cli/plan.ts denies each verb in GIT_WRITE_VERBS as `Bash(git <verb>)` and `Bash(git <verb> *)`, and allow holds a bare `Bash`. Those rules match the command text from its start, so `git -C . commit` or `git -C . branch` matches no deny rule and is allowed at the permission layer. The plan.ts comment says these rules guide the model and stop the obvious forms, and that the real boundary is the sandbox denyWrite on <main>/.git and <worktree>/.git plus the closed network; this story does not change that boundary. DIPO-192's L1 line no longer suggests git -C. L1 says (DIPO-189) that git branch is denied in every form, which `git -C . branch` breaks today.

ADR 0008 section 2 lists the deny rules as "`Bash(git commit *)` and the other git write verbs", so the added forms get a dated 0008 note that the maintainer approves; this story does not edit docs/decisions/.

```dipo
branch: "DIPO-204/deny-git-global-options"
unknowns:
  - q: "Do you approve a dated 0008 section 2 note that the git write-verb deny rules also cover the verb after git's global options (-C <path>, -c <name>=<value>, --git-dir, --work-tree), written as Bash(git -C * <verb>) and Bash(git -C * <verb> *) and the like?"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the run settings deny git -C . commit, git -C . branch and git -c x=y commit for every verb in GIT_WRITE_VERBS, and still deny no git rev-parse form"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The run settings from plan.ts deny every verb in GIT_WRITE_VERBS also after the global options -C <path> and -c <name>=<value>, and a test in packages/engine/test/workers/plan.test.ts asserts the deny rules for git -C . commit, git -C . branch and git -c x=y push, with the rule strings written as literals in the test
- [ ] #2 No deny rule starts with Bash(git rev-parse) or Bash(git -C * rev-parse), and the plan golden files are updated
<!-- AC:END -->
