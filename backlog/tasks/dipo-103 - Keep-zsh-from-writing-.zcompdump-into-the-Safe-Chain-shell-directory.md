---
id: DIPO-103
title: Keep zsh from writing .zcompdump into the Safe-Chain shell directory
status: To Do
assignee: []
created_date: '2026-10-15 19:23'
labels:
  - 'tier:S'
milestone: m-0
dependencies: []
references:
  - packages/engine/src/workers/claude-cli/safe-chain.ts
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
