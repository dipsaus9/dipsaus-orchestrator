---
id: DIPO-107
title: Keep the worker PATH order when the shell runs as a login shell
status: To Do
assignee: []
created_date: '2026-10-16 07:55'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/workers/claude-cli/safe-chain.ts
priority: low
type: feature
ordinal: 97000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a PATH entry the Safe-Chain plan moved to the end of the worker PATH stays at the end, also when Claude Code starts the worker shell as a login shell.

Context: the Safe-Chain plan demotes PATH entries whose wrapped command points where the sandbox cannot read (packages/engine/src/workers/claude-cli/safe-chain.ts). If the shell is started with -l, macOS /etc/zprofile runs path_helper, which moves the /etc/paths entries (for example /usr/local/bin) back to the front, so a demoted entry can win again. Found as a review advisory on the Safe-Chain stories. This is functional only, not security: path_helper adds only root-owned system directories, and the self-test still refuses worker-writable PATH entries.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Measure whether Claude Code starts the worker shell as a login shell; if it does not, record that in the story notes and close it with no code change.
- [ ] #2 If it does, the wrapper restores the planned PATH after the login files have run (for example in the zsh init that also sets ZDOTDIR), and the bash variant does the same.
- [ ] #3 A test shows the planned PATH order in a login shell on macOS.
<!-- AC:END -->
