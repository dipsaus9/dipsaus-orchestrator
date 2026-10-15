---
id: DIPO-84
title: Let workers install packages through Safe-Chain
status: To Do
assignee: []
created_date: '2026-10-15 14:10'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-82
priority: high
ordinal: 74000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: on a machine with the official Aikido Safe-Chain, a worker can install packages (bun add, npm install, pnpm/yarn add, pip install and the other managers Safe-Chain wraps) from inside the dipo sandbox, and every install goes through Safe-Chain's malware check.

Context: the maintainer decided on 2026-10-15: workers always use Safe-Chain from now on, workers are allowed to install packages, the official Aikido Safe-Chain is fine, and an ADR amendment is approved. DIPO-82's investigation (story notes) measured what an install through Safe-Chain needs inside the worker sandbox: network to the package registry and malware-list.aikido.dev, allowLocalBinding (Safe-Chain's proxy listens on 127.0.0.1), and writes to TMPDIR (CA bundle) and the package manager's install cache; read/write of ~/.safe-chain for its malware-list cache is optional. Machines without Safe-Chain keep the closed worker network.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 With Safe-Chain detected, the worker sandbox allows network only to the package registries the wrapped managers need (at least registry.npmjs.org; measure yarn, pnpm and pip/pypi hosts) plus Aikido's malware-list host(s), sets allowLocalBinding, and allows writes to the install cache paths and TMPDIR the installs need; nothing else opens, and a machine without Safe-Chain launches exactly as before.
- [ ] #2 Inside the sandbox replay (no Claude session) and in a live Haiku run on the scratch repo, a worker's bun add of a small pinned package succeeds through Safe-Chain, and an install of Safe-Chain's own test malware package (or another documented blocked case) is refused by Safe-Chain.
- [ ] #3 dipo run --dry-run shows the opened hosts, local binding and write paths with the reason (Safe-Chain installs), and the self-test or launch check reports clearly when Safe-Chain is present but installs cannot work.
- [ ] #4 The approved ADR 0008 amendment for installs through Safe-Chain is recorded, and tests cover the plan with and without Safe-Chain.
<!-- AC:END -->
