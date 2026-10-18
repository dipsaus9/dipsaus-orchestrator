---
id: DIPO-192
title: Tell the worker to run every command from the worktree root
status: Done
assignee: []
created_date: '2026-10-17 23:16'
updated_date: '2026-10-18 08:58'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/prompts/contract/implement.md
  - packages/engine/test/prompts/
  - packages/engine/test/prompts/golden/system-implement-developer.md
priority: high
type: bug
ordinal: 181000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker runs its commands from the worktree root and never changes directory, so the run settings' `./` rules keep matching its own files and its writes are not denied.

Context: the M1a run of DIPO-128 (run_01M55RCY1AT0DGM1CM53BCBJHV). The worker ran `cd packages/engine/src/run`. Its next Write, to packages/engine/test/run/deciding.test.ts, needed approval and was denied automatically, and the hook event's cwd field named the subdirectory. The run settings allow Read(./**), Edit(./**) and Write(./**) (permissions in packages/engine/src/workers/claude-cli/plan.ts), and Claude Code resolved `./` against the shell's current directory, not the worktree. The shell kept that directory for the later calls. Writing the rules with the absolute worktree path is DIPO-193, which needs an ADR 0008 amendment. This story is the L1 line alone, which needs no ADR change, and it also helps once DIPO-193 lands: paths from the root are the paths the task names. L1 stays the same for every story with the same role (0014 section 5), and the system file test allows only /tmp as a path, so the new text names commands, not paths.

```dipo
branch: "DIPO-192/run-commands-from-worktree-root"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(golden) the rendered system file says to run every command from the worktree root, never to cd, and to pass paths from the root instead"
    - kind: "manual"
      check: "(live) on the scratch repo, run a story whose files sit two directories below the root"
      expect: "the worker runs no cd command, and no Write or Edit call in the run is denied"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 L1 (packages/engine/src/prompts/contract/implement.md) says the worker runs every command from the worktree root, never changes directory with cd, also not inside a compound command, and passes file paths relative to the worktree root instead (for example to bun test or git -C); the new text names no path
- [x] #2 packages/engine/test/prompts/golden/system-implement-developer.md is updated, and a test in packages/engine/test/prompts/system.test.ts asserts the rendered system file holds the new rule; both tests pass
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M573EBZ41TM6JXMVKDX23HFC (Haiku low, 10 turns, about $0.01, 2 min) reported done, both criteria, In Review on DIPO-192/run-commands-from-worktree-root, with no denied call. Verify outside the sandbox on DIPO-192/run-commands-from-worktree-root-finish (origin/main merged in): 0 fail. Review passed. Applied on top: the example no longer names git -C, which resolves later paths against another directory and slips past the prefix deny rules for git write verbs (git -C . commit matches no Bash(git commit) rule); it now says to pass paths after -- in a git command. That deny gap is filed as its own story. The live scratch-repo check (no cd, no denied Write or Edit) is left for the maintainer's hand-test session.
<!-- SECTION:NOTES:END -->
