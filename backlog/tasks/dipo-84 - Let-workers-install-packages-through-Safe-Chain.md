---
id: DIPO-84
title: Let workers install packages through Safe-Chain
status: To Do
assignee: []
created_date: '2026-10-15 14:10'
updated_date: '2026-10-15 14:39'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-82
references:
  - packages/engine/src/workers/claude-cli
  - packages/engine/src/sandbox
  - packages/engine/src/platform/safe-chain-proxy.ts
  - packages/engine/src/run/verify-commit.ts
  - packages/engine/src/run/launch.ts
  - packages/engine/src/index.ts
  - packages/engine/test/workers
  - packages/engine/test/sandbox
  - packages/engine/test/run
  - packages/daemon/src
  - packages/cli/src
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
- [ ] #1 Inside the sandbox replay (no Claude session) and in a live Haiku run on the scratch repo, a worker's bun add of a small pinned package succeeds through Safe-Chain, and an install of Safe-Chain's own test malware package (or another documented blocked case) is refused by Safe-Chain.
- [ ] #2 dipo run --dry-run shows the opened hosts, local binding and write paths with the reason (Safe-Chain installs), and the self-test or launch check reports clearly when Safe-Chain is present but installs cannot work.
- [ ] #3 The approved ADR 0008 amendment for installs through Safe-Chain is recorded, and tests cover the plan with and without Safe-Chain.
- [ ] #4 With Safe-Chain detected, workers install through a Safe-Chain checking proxy that dipo runs outside the worker sandbox (maintainer decision 2026-10-15, option B): the worker sandbox keeps allowLocalBinding false and localhost closed, its network reaches only that proxy route to the package registries (npm, yarn, pypi as measured) and Aikido's malware list, install caches go to the run temp dir, and ~/.safe-chain stays read-only. A machine without Safe-Chain launches exactly as before.
- [ ] #5 When a run's committed changes include dependency files (package.json, bun.lock, bun.lockb, package-lock.json, pnpm-lock.yaml, yarn.lock, requirements*.txt, pyproject.toml, poetry.lock, uv.lock), dipo raises an engine notice on the run and story naming the changed files, detected by code from the run's diff at commit time with no model involved, so the maintainer sees new packages at review.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Maintainer decision 2026-10-15: option B. The DIPO-84 investigation found that Safe-Chain's own proxy needs allowLocalBinding, which on macOS lets sandboxed code connect to every localhost TCP service (for example the backlog browser on :6420) and listen on any interface; srt cannot narrow it. So dipo runs the checking proxy outside the sandbox instead. Measured per manager: bun and npm and pnpm use registry.npmjs.org, yarn 1 uses registry.yarnpkg.com (needs --no-default-rc), pip uses pypi.org and files.pythonhosted.org; all fetch malware-list.aikido.dev; caches redirect with BUN_INSTALL_CACHE_DIR, npm_config_cache, YARN_CACHE_FOLDER, XDG_DATA_HOME, XDG_CACHE_HOME, PIP_CACHE_DIR; blocked case: safe-chain-test (npm) is refused by bun, npm, pnpm and yarn; pip has no working test package. Never grant writes to ~/.safe-chain (its bin and scripts run unsandboxed in the maintainer's shell). Fallback if B proves infeasible: installs only in dipo's setup phase through Safe-Chain (option C), reported to the maintainer before building.
<!-- SECTION:NOTES:END -->
