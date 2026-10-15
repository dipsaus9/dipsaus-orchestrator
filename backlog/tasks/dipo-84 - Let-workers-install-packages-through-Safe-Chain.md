---
id: DIPO-84
title: Let workers install packages through Safe-Chain
status: To Do
assignee: []
created_date: '2026-10-15 14:10'
updated_date: '2026-10-15 16:55'
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
- [x] #2 dipo run --dry-run shows the opened hosts, local binding and write paths with the reason (Safe-Chain installs), and the self-test or launch check reports clearly when Safe-Chain is present but installs cannot work.
- [ ] #3 The approved ADR 0008 amendment for installs through Safe-Chain is recorded, and tests cover the plan with and without Safe-Chain.
- [x] #4 With Safe-Chain detected, workers install through a Safe-Chain checking proxy that dipo runs outside the worker sandbox (maintainer decision 2026-10-15, option B): the worker sandbox keeps allowLocalBinding false and localhost closed, its network reaches only that proxy route to the package registries (npm, yarn, pypi as measured) and Aikido's malware list, install caches go to the run temp dir, and ~/.safe-chain stays read-only. A machine without Safe-Chain launches exactly as before.
- [x] #5 When a run's committed changes include dependency files (package.json, bun.lock, bun.lockb, package-lock.json, pnpm-lock.yaml, yarn.lock, requirements*.txt, pyproject.toml, poetry.lock, uv.lock), dipo raises an engine notice on the run and story naming the changed files, detected by code from the run's diff at commit time with no model involved, so the maintainer sees new packages at review.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Maintainer decision 2026-10-15: option B. The DIPO-84 investigation found that Safe-Chain's own proxy needs allowLocalBinding, which on macOS lets sandboxed code connect to every localhost TCP service (for example the backlog browser on :6420) and listen on any interface; srt cannot narrow it. So dipo runs the checking proxy outside the sandbox instead. Measured per manager: bun and npm and pnpm use registry.npmjs.org, yarn 1 uses registry.yarnpkg.com (needs --no-default-rc), pip uses pypi.org and files.pythonhosted.org; all fetch malware-list.aikido.dev; caches redirect with BUN_INSTALL_CACHE_DIR, npm_config_cache, YARN_CACHE_FOLDER, XDG_DATA_HOME, XDG_CACHE_HOME, PIP_CACHE_DIR; blocked case: safe-chain-test (npm) is refused by bun, npm, pnpm and yarn; pip has no working test package. Never grant writes to ~/.safe-chain (its bin and scripts run unsandboxed in the maintainer's shell). Fallback if B proves infeasible: installs only in dipo's setup phase through Safe-Chain (option C), reported to the maintainer before building.

## Feasibility of option B (2026-10-15, srt 0.0.79, Safe-Chain 1.5.12, no Claude session)

- Safe-Chain has no proxy mode: `safe-chain <manager> <args>` starts its checking proxy on 127.0.0.1:0 and runs the manager with HTTPS_PROXY and NODE_EXTRA_CA_CERTS. dipo runs it with a holder script named like the manager (bun, pip3) that writes those two values to a file and waits on stdin, so the proxy stays up until dipo closes that stdin.
- Safe-Chain checks one ecosystem per process (bun: registry.npmjs.org, registry.yarnpkg.com; pip3: pypi.org, files.pythonhosted.org) and tunnels other hosts unchecked, so dipo runs two.
- The packaged binary takes its install directory from its own path: a copy at <dir>/sc/bin/safe-chain makes a fresh CA in <dir>/sc/certs. ~/.safe-chain is only read (the copy), never written, never read inside any sandbox.
- Safe-Chain forwards plain HTTP to any host and tunnels CONNECT to any host. Measured: inside a proxy sandbox with allowLocalBinding, a plain GET through Safe-Chain reached a 127.0.0.1 listener. So a gate (dipo code, inside the same sandbox) sits in front and passes only CONNECT <one of the four registries>:443.
- srt/Claude Code: network.httpProxyPort replaces the sandbox's own HTTP proxy; the sandbox profile then allows connecting only to that port. Claude Code settings expose httpProxyPort (no parentProxy); its SOCKS proxy keeps allowedDomains [] (denies all).
- Measured in the srt harness, worker sandbox allowLocalBinding false, httpProxyPort = dipo's port: bun add is-number@7.0.0 succeeds; bun add safe-chain-test fails with 403 from Safe-Chain; pip install six==1.16.0 succeeds; direct connect to a 127.0.0.1 listener refused (curl 7); plain GET to it through the proxy refused by the gate (403); CONNECT to it, to example.com and to malware-list.aikido.dev refused; Safe-Chain's own ports refused (curl 7); ~/.safe-chain and the proxy dir unreadable.
- Proxy sandbox (srt via dipo daemon sandbox-exec): network registry hosts + malware-list.aikido.dev, allowLocalBinding true (Safe-Chain listens on 127.0.0.1; srt grants a listen only that way; no worker code runs there), home read-denied except the dipo binary, writes only to its own dir. Safe-Chain reaches the registries through srt's proxy (it honours HTTPS_PROXY), so srt's allowlist also filters it.
- Linux is not measured: srt isolates network in a namespace there; the gate listens on a Unix socket and dipo forwards a local TCP port to it byte for byte, which does not depend on the namespace, but the launch check is what proves it.

## Implementation

- sandbox/safe-chain-proxy.ts (pure: hosts, gate rule, holder, proxy policy, cache and CA variables), platform/safe-chain-gate.ts (in the sandbox), platform/safe-chain-proxy.ts (daemon side: dir, copy, policy, sandbox-exec, CA bundle copy to <runDir>/safe-chain/ca.pem, 127.0.0.1:0 forwarder, proxy check: is-number 200, safe-chain-test 403, example.com 403), sandbox/safe-chain-proxies.ts (one per run; stops at session end, after 120 s without a host, when its gate exits, with the daemon).
- Plan with Safe-Chain: sandbox network {allowedDomains: [], strictAllowlist, allowLocalBinding: false, httpProxyPort}; denyRead + the proxy dir; allowRead only the wrapper dir (no ~/.safe-chain); wrapper exports PATH, caches under <tmpDir>/caches, CA variables; .zshenv loads nothing; safe-chain/proxy.json describes the route for the dry run (port 0 and a placeholder dir there). An office with allowedDomains or allowLocalBinding true is refused while Safe-Chain is installed.
- prepareLaunch starts the proxy inside the launch gate; a proxy that cannot start or fails its check refuses the run with a safe-chain/proxy hold. Self-test: bun add is-number@7.0.0 must exit 0 and bun add safe-chain-test must not (exit 0 there is unsafe).
- verify.dependenciesChanged (warn) on the run and story at the In Review commit, naming committed manifests, lockfiles and requirements*.txt.
- Known limit: after a daemon restart a re-attached worker has no proxy (its installs fail, never unchecked); a killed daemon can leave /tmp/dipo-p-* directories.
<!-- SECTION:NOTES:END -->
