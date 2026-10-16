---
id: DIPO-107
title: Keep the worker PATH order when the shell runs as a login shell
status: To Do
assignee: []
created_date: '2026-10-16 07:55'
updated_date: '2026-10-16 13:20'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/workers/claude-cli/safe-chain.ts
  - packages/engine/test/
priority: low
type: feature
ordinal: 97000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a PATH entry the Safe-Chain plan moved to the end of the worker PATH stays at the end after the shell's system startup files run, login shell or not.

Context: the Safe-Chain plan demotes PATH entries whose wrapped command points where the sandbox cannot read (packages/engine/src/workers/claude-cli/safe-chain.ts). If the shell is started with -l, macOS /etc/zprofile runs path_helper, which moves the /etc/paths entries (for example /usr/local/bin) back to the front, so a demoted entry can win again. The zsh init the plan writes runs as .zshenv, before /etc/zprofile, and sets ZDOTDIR=/dev/null (ZSH_STATE_NOWHERE, DIPO-103) so no dipo-owned .zprofile or .zlogin runs afterwards; a fix needs a login-only hook that runs after /etc/zprofile while keeping DIPO-103's behaviour for non-login shells. bash reads /etc/profile in a login shell, and whether the plan's BASH_ENV file runs before or after it is part of the fix. Whether Claude Code starts its shell with -l is not measured; this story makes the order hold either way. Out of scope: a user's own ~/.zshrc, which the Claude Code shell snapshot sources by path and which can reorder PATH too. Found as a review advisory on the Safe-Chain stories. This is functional only, not security: path_helper adds only root-owned system directories, and the self-test still refuses worker-writable PATH entries.

```dipo
branch: "DIPO-107/keep-path-order-in-login-shell"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(macOS only, skipped elsewhere) a zsh and a bash login shell started through the plan's init keep the planned PATH order, with a demoted entry still last, and a non-login shell is unchanged"
    - kind: "automated"
      check: "(unit) the generated zsh and bash init restore the planned PATH after the login files run, and keep ZDOTDIR=/dev/null for non-login zsh"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 In a zsh login shell started through the plan's init, the planned PATH order is restored after /etc/zprofile runs, through a login-only hook; non-login shells keep DIPO-103's ZDOTDIR=/dev/null behaviour
- [ ] #2 The bash variant restores the planned PATH after its login files run in the same way
- [ ] #3 A macOS test (skipped on other platforms) in a plain *.test.ts file, not *.ci.test.ts, so the local verify on macOS runs it, shows the planned PATH order in a zsh and a bash login shell; unit tests cover the generated zsh and bash init
<!-- AC:END -->
