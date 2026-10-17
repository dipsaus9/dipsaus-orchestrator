---
id: DIPO-178
title: Keep the user's bash profile files out of a bash login worker shell
status: Ready
assignee: []
created_date: '2026-10-17 17:00'
updated_date: '2026-10-17 20:16'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/workers/claude-cli/safe-chain.ts
  - packages/engine/test/workers/
priority: medium
type: bug
ordinal: 167000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a bash login worker shell loads none of the maintainer's own bash profile files, as the DIPO-84 wrapper rule says for every worker shell.

Context: finding 23 of the DIPO-115 cutover, from the DIPO-107 review (pre-existing on main). With Safe-Chain installed, Claude Code's shell is dipo's wrapper (packages/engine/src/workers/claude-cli/safe-chain.ts), which starts bash with BASH_ENV on dipo's init file. A bash login shell first runs the system profile and then the first of ~/.bash_profile, ~/.bash_login and ~/.profile, so the maintainer's shell setup loads in the worker, against the DIPO-84 rule that nothing the maintainer's shell loads reaches the worker. zsh has no such gap: DIPO-107 keeps ZDOTDIR on the run's shell directory for a login shell, so zsh reads dipo's .zprofile (ZSH_STATE_NOWHERE and zshLoginText). One option: the wrapper starts a bash login shell with --noprofile and sets the planned PATH itself; path_helper then does not run either, which the planned PATH makes unnecessary.

```dipo
branch: "DIPO-178/bash-login-without-user-profiles"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(ci) bash -l through the wrapper with a temp home holding .bash_profile, .bash_login and .profile writes no marker and has the planned PATH"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A bash login shell started through the worker shell wrapper runs none of ~/.bash_profile, ~/.bash_login and ~/.profile of the home directory
- [ ] #2 In that shell PATH equals the planned PATH, with the demoted entries last, as DIPO-107 asserts for bash today
- [ ] #3 A bash shell that is not a login shell and every zsh shell behave as before: their existing tests in packages/engine/test/workers/ pass unchanged
- [ ] #4 A test starts the wrapper as a bash login shell with a temp home whose three profile files each write a marker file, and finds no marker
<!-- AC:END -->
