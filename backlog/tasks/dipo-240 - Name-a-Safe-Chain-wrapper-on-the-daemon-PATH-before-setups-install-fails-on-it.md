---
id: DIPO-240
title: >-
  Name a Safe-Chain wrapper on the daemon PATH before setup's install fails on
  it
status: Refined
assignee: []
created_date: '2026-10-20 18:34'
updated_date: '2026-10-22 08:33'
labels:
  - 'tier:M'
  - cutover
  - needs-refinement
milestone: m-1
dependencies:
  - DIPO-183
  - DIPO-228
  - DIPO-231
  - DIPO-250
  - DIPO-257
  - DIPO-255
  - DIPO-294
  - DIPO-295
references:
  - packages/engine/src/worktree/setup.ts
  - packages/engine/src/sandbox/step.ts
  - packages/engine/src/sandbox/safe-chain-proxy.ts
  - packages/engine/src/sandbox/safe-chain-proxies.ts
  - packages/engine/src/workers/claude-cli/safe-chain.ts
  - packages/engine/src/workers/claude-cli/launch-checks.ts
  - packages/daemon/src/runs.ts
  - packages/engine/test/worktree/
  - packages/engine/test/sandbox/safe-chain-proxy.test.ts
  - packages/engine/test/workers/launch-checks.test.ts
priority: high
type: bug
ordinal: 240000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: when the official Safe-Chain is installed, setup's install step runs through the run's Safe-Chain checking proxy, as worker installs do, so setup installs are checked and a run no longer fails at setup with a bare "listen EPERM 127.0.0.1" because the daemon's PATH starts with Safe-Chain's wrapper for the install program.

Context: G31 (2026-10-18, DIPO-177) and again on 2026-10-20 (DIPO-231, twice, after a daemon restart from a shell whose PATH had ~/.bun/bin first). Setup (packages/engine/src/worktree/setup.ts) runs the run profile's install (`bun install --frozen-lockfile`) through the sandboxed step runner (packages/engine/src/sandbox/step.ts) with the daemon's environment. When the daemon's PATH resolves bun to Safe-Chain's wrapper, the wrapper starts its own checking listener inside the step sandbox, which refuses it: "Failed to check for malicious packages: listen EPERM: operation not permitted 127.0.0.1" (or, in G31, mktemp EPERM). The failure text is all the maintainer sees, at info level the output is "[debug only]", and nothing says the PATH order is the cause. With the real bun first, setup passes, but then setup's install is not checked by Safe-Chain at all. Worker installs go only through a per-run Safe-Chain checking proxy dipo runs outside the worker sandbox (0008 section 2, DIPO-84); detectSafeChain (packages/engine/src/workers/claude-cli/safe-chain.ts) finds the official install and sorts the worker PATH. Today the run's proxy starts only at launch, after setup: claudeLaunchChecks in packages/engine/src/workers/claude-cli/launch-checks.ts calls SafeChainProxies.start (packages/engine/src/sandbox/safe-chain-proxies.ts, which stops an earlier proxy of the same run first) and routes the plan through its port; the proxy itself is packages/engine/src/sandbox/safe-chain-proxy.ts. The daemon builds setup's dependencies (SetupDeps, its runStep) and the proxies in packages/daemon/src/runs.ts. The 0008 section 2 note of 2026-10-20 (DIPO-240) records that the proxy also serves setup.

```dipo
branch: "DIPO-240/setup-install-safe-chain"
unknowns:
  - q: "How should setup's install meet Safe-Chain? (a) Setup's install step runs through the run's Safe-Chain checking proxy, as worker installs do (DIPO-84), so setup installs are checked and the wrapper's own listener is never needed; a dated 0008 section 2 note records that the proxy also serves setup (recommended: installs stay checked, which is the DIPO-84 rule, and today setup installs are unchecked whenever the real bun comes first). (b) No proxy for setup: before a claim, an office check refuses the run when the install program on the daemon PATH is Safe-Chain's wrapper, naming the wrapper path and saying to start the daemon with the real program first; setup installs stay unchecked."
    status: "resolved"
    answer: "A (maintainer, 2026-10-20): approved; the 0008 section 2 note of 2026-10-20 (DIPO-240): setup's install step also runs through the run's Safe-Chain checking proxy, as worker installs do (DIPO-84), so setup installs are checked too and setup no longer needs a Safe-Chain wrapper on the daemon PATH."
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) with Safe-Chain detected, setup starts the run's proxy before the install step, and the install step's environment and sandbox settings route the package manager through the proxy port as a worker install is routed"
    - kind: "automated"
      check: "(unit) a proxy that fails to start fails setup with a reason naming Safe-Chain and the proxy failure, runs no install, and the claim rolls back; a failed install stops the proxy"
    - kind: "automated"
      check: "(unit) the launch after a setup that started the proxy routes the worker through the run's proxy, and with no Safe-Chain install setup runs as today"
    - kind: "manual"
      check: "(live) start the temp daemon from a shell with the Safe-Chain wrapper first on PATH and start a Ready story"
      expect: "setup's install passes through the run's proxy, and the proxy's log shows the install's package checks"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 When the official Safe-Chain install is detected, setup in packages/engine/src/worktree/setup.ts starts the run's Safe-Chain checking proxy (SafeChainProxies.start) before the install step, and the install step's environment and sandbox settings route the package manager through the proxy port as a worker install is routed (DIPO-84), so the install never starts the Safe-Chain wrapper's own listener inside the step sandbox
- [ ] #2 A proxy that does not start fails setup with a reason that names Safe-Chain and the proxy failure, no install runs, and the claim rolls back as for any setup failure; a setup that fails after the proxy started stops that proxy
- [ ] #3 The launch after setup routes the worker through the run's proxy, either the one setup started or one started again under the rule of safe-chain-proxies.ts, and the run never has two proxies at once
- [ ] #4 With no Safe-Chain install, setup and the launch behave as today
- [ ] #5 Unit tests in packages/engine/test/worktree/ and packages/engine/test/workers/launch-checks.test.ts cover the routed install, a proxy that fails to start, a failed install that stops the proxy, the launch's proxy after setup, and the case with no Safe-Chain install, with fake proxies and fake files
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: installs move into the box and the read-only cache dipo fills through Safe-Chain (0021 section 5).
<!-- SECTION:NOTES:END -->
