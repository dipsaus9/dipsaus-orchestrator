---
id: DIPO-103
title: Keep zsh from writing .zcompdump into the Safe-Chain shell directory
status: To Do
assignee: []
created_date: '2026-10-15 19:23'
updated_date: '2026-10-15 20:54'
labels:
  - 'tier:S'
milestone: m-0
dependencies: []
references:
  - packages/engine/src/workers/claude-cli/safe-chain.ts
  - packages/engine/test/workers/safe-chain.test.ts
  - packages/engine/test/workers/safe-chain-shell.ci.test.ts
priority: low
type: feature
ordinal: 93000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the Safe-Chain worker shell directory holds only the files dipo writes; zsh writes no .zcompdump (or other state) there.

Context: seen in the DIPO-84 test on 2026-10-15: <run>/safe-chain held a .zcompdump. The worker shell starts zsh with ZDOTDIR on the Safe-Chain shell directory (packages/engine/src/workers/claude-cli/safe-chain.ts:16, :269), so a compinit run by the system zsh startup files writes its dump there.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The cause is found and written in the story notes (which startup file runs compinit, under which zsh options).
- [ ] #2 The worker shell starts without writing .zcompdump or any other file into the Safe-Chain shell directory (for example by skipping global rc files or pointing the dump elsewhere inside the run temp dir), and the Safe-Chain functions still load.
- [ ] #3 A test (CI-only if it needs zsh) checks the directory listing after a shell start.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Cause (investigated 2026-10-15, zsh 5.9 on macOS, Claude Code 2.1.301):

- Not a system startup file. /etc/zshenv does not exist, /etc/zprofile only runs path_helper, /etc/zshrc and /etc/zshrc_Apple_Terminal do not run compinit. zsh started with ZDOTDIR on an empty temp dir in every mode (-c, -l -c, -i -c, -i -l -c) writes nothing there.
- It is Claude Code's shell snapshot. Once per session Claude Code runs its shell (CLAUDE_CODE_SHELL, our wrapper) as `<shell> -c -l <script>`, outside the worker sandbox, and the script runs `source "$HOME/.zshrc" < /dev/null`. The path is os.homedir()/.zshrc, hard-coded: it ignores ZDOTDIR. So the maintainer's ~/.zshrc runs with ZDOTDIR on the Safe-Chain shell directory.
- On this machine the compinit comes from nvm's bash_completion, which ~/.zshrc sources: when compinit is not defined it runs `autoload -U +X compinit && compinit`. compinit dumps to ${ZDOTDIR:-$HOME}/.zcompdump, so the dump lands in <run>/safe-chain. Any rc that calls compinit (oh-my-zsh, a plain `autoload -Uz compinit; compinit`) does the same. Options: a non-interactive login shell (-c -l), no special options; GLOBAL_RCS and RCS are on, but neither matters here, because the source is explicit.
- Reproduced: ZDOTDIR=/tmp/d103/real zsh -c -l 'source "$HOME/.zshrc" < /dev/null' leaves .zcompdump in /tmp/d103/real; xtrace shows ~/.nvm/bash_completion:93 calling compinit.

Consequences for the fix:
- `zsh -f` or NO_GLOBAL_RCS would not help: the snapshot sources ~/.zshrc by path.
- The dump must not go to a directory the worker can write (for example the run temp directory): compinit sources an existing .zcompdump, and the snapshot runs outside the sandbox, so a worker-written dump would run code outside the sandbox at the next session start.

Fix: the init file (.zshenv) sets `export ZDOTDIR=/dev/null` after zsh has read it. Every later startup file (.zprofile, .zshrc, .zlogin) and every ${ZDOTDIR:-$HOME} write (.zcompdump, interactive history) then points under /dev/null, which is not a directory: nothing is read or written, and child zsh processes read no user rc files either. The wrapper still exports ZDOTDIR on the Safe-Chain shell directory, so every worker shell keeps reading the init file. The snapshot's compinit prints a "no such file or directory" error for its dump; Claude Code ignores stderr of a snapshot that succeeds.
<!-- SECTION:NOTES:END -->
