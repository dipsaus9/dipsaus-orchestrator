---
id: DIPO-193
title: Anchor the worker's file permission rules at the absolute worktree path
status: Refined
assignee: []
created_date: '2026-10-17 23:16'
updated_date: '2026-10-17 23:16'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/workers/claude-cli/plan.ts
  - packages/engine/test/workers/plan.test.ts
  - packages/engine/test/workers/golden/
priority: high
type: bug
ordinal: 182000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the run settings' Read, Edit and Write rules for the worktree name its absolute path, so they match the same files whatever directory the worker's shell is in, and the deny rules for the worktree's .git, backlog, .dipo, Claude settings and .env files still hold after a cd.

Context: the M1a run of DIPO-128 (run_01M55RCY1AT0DGM1CM53BCBJHV). After the worker ran `cd packages/engine/src/run`, a Write to packages/engine/test/run/deciding.test.ts needed approval and was denied automatically. The hook event's cwd field showed the subdirectory: Claude Code resolved `./` in Read(./**), Edit(./**) and Write(./**) against the shell's current directory. permissions() in packages/engine/src/workers/claude-cli/plan.ts writes the worktree's deny rules with `./` too: Edit and Write of ./.git, ./.git/**, ./backlog/**, ./.dipo/** and the two ./.claude settings files, and Read(./**/.env*). After a cd those rules likely stop covering the root's files, so an Edit of a root backlog file needs approval instead of being denied, and Read(./**/.env*) no longer covers a root .env file. That part is inferred from the allow rules' behaviour, not observed; the manual entry checks it. The main checkout rules already use the absolute form, `/` followed by the absolute path (`//<main>/**`), and the workdir already passes through ruleSafe in plan(). DIPO-192 adds the L1 line that tells the worker not to cd.

ADR 0008 section 2 says "The worker is started in the worktree, so `./` is the worktree" and lists the `./` rules, so this change needs a dated 0008 amendment that the maintainer approves. This story does not edit docs/decisions/, and it stays open until the unknown below is answered.

```dipo
branch: "DIPO-193/absolute-worktree-rules"
unknowns:
  - q: "Do you approve a dated amendment of 0008 section 2 that writes the worktree's allow and deny rules with the absolute worktree path (//<worktree>/**, //<worktree>/backlog/** and so on, as the main checkout rules are written) instead of ./, because Claude Code resolves ./ against the shell's current directory (run_01M55RCY1AT0DGM1CM53BCBJHV)?"
    status: "open"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the run settings hold the worktree allow rules and the .git, backlog, .dipo, Claude settings and .env deny rules on the absolute worktree path, and no permission rule starts with ./"
    - kind: "automated"
      check: "(golden) the S, M and L plan golden files show the absolute worktree rules"
    - kind: "manual"
      check: "(live) on the scratch repo, run a story whose task makes the worker cd into a subdirectory, then write a file elsewhere in the worktree and edit a backlog task file"
      expect: "the write is allowed without a permission request, and the backlog edit is denied by a deny rule"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 permissions() in packages/engine/src/workers/claude-cli/plan.ts writes the allow rules Read, Edit and Write and the worktree deny rules (.git, .git/**, backlog/**, .dipo/**, .claude/settings.json, .claude/settings.local.json for Edit and Write, and **/.env* for Read) on the absolute worktree path, in the form the main checkout rules use; no permission rule in the run settings starts with ./
- [ ] #2 The worktree path in these rules is the one plan() passes through ruleSafe, so a worktree path a rule cannot hold refuses the plan with PlanError, as it does today
- [ ] #3 Tests in packages/engine/test/workers/plan.test.ts assert the rules of #1 for a fixture worktree path and that no rule starts with ./, and packages/engine/test/workers/golden/plan-S.json, plan-M.json and plan-L.json are updated; the tests pass
<!-- AC:END -->
