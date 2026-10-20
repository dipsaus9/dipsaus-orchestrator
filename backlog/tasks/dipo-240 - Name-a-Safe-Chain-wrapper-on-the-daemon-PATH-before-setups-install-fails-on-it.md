---
id: DIPO-240
title: >-
  Name a Safe-Chain wrapper on the daemon PATH before setup's install fails on
  it
status: To Do
assignee: []
created_date: '2026-10-20 18:34'
updated_date: '2026-10-20 18:39'
labels:
  - 'tier:M'
  - cutover
  - needs-info
milestone: m-1
dependencies:
  - DIPO-183
  - DIPO-228
references:
  - packages/engine/src/worktree/setup.ts
  - packages/engine/src/sandbox/step.ts
  - packages/engine/src/workers/claude-cli/safe-chain.ts
  - packages/engine/src/run/work-run.ts
  - packages/engine/test/worktree/
  - packages/engine/test/run/work-run.test.ts
priority: high
type: bug
ordinal: 240000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a run never fails at setup with a bare "listen EPERM 127.0.0.1" because the daemon's PATH starts with Safe-Chain's wrapper for the install program; dipo either runs setup's install through its own Safe-Chain checking proxy or refuses the run up front with a reason that names the wrapper and the fix.

Context: G31 (2026-10-18, DIPO-177) and again on 2026-10-20 (DIPO-231, twice, after a daemon restart from a shell whose PATH had ~/.bun/bin first). Setup (packages/engine/src/worktree/setup.ts) runs the run profile's install (`bun install --frozen-lockfile`) through the sandboxed step runner (packages/engine/src/sandbox/step.ts) with the daemon's environment. When the daemon's PATH resolves bun to Safe-Chain's wrapper, the wrapper starts its own checking listener inside the step sandbox, which refuses it: "Failed to check for malicious packages: listen EPERM: operation not permitted 127.0.0.1" (or, in G31, mktemp EPERM). The failure text is all the maintainer sees, at info level the output is "[debug only]", and nothing says the PATH order is the cause. With the real bun first, setup passes, but then setup's install is not checked by Safe-Chain at all. Worker installs go only through a per-run Safe-Chain checking proxy dipo runs outside the worker sandbox (0008 section 2, DIPO-84); detectSafeChain (packages/engine/src/workers/claude-cli/safe-chain.ts) finds the official install and sorts the worker PATH. The run's office checks are in packages/engine/src/run/work-run.ts (`refusals`).

```dipo
branch: "DIPO-240/setup-install-safe-chain"
unknowns:
  - q: "How should setup's install meet Safe-Chain? (a) Setup's install step runs through the run's Safe-Chain checking proxy, as worker installs do (DIPO-84), so setup installs are checked and the wrapper's own listener is never needed; a dated 0008 section 2 note records that the proxy also serves setup (recommended: installs stay checked, which is the DIPO-84 rule, and today setup installs are unchecked whenever the real bun comes first). (b) No proxy for setup: before a claim, an office check refuses the run when the install program on the daemon PATH is Safe-Chain's wrapper, naming the wrapper path and saying to start the daemon with the real program first; setup installs stay unchecked."
    status: "open"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) with a fake PATH whose first bun is a Safe-Chain wrapper, the chosen path holds: (a) setup's install step gets the proxy's environment and settings, or (b) work.preview and work.run refuse with the check naming the wrapper"
    - kind: "automated"
      check: "(unit) with the real bun first and no Safe-Chain install, setup runs as today"
    - kind: "manual"
      check: "(live) start the temp daemon from a shell with the Safe-Chain wrapper first on PATH and start a Ready story"
      expect: "with (a) setup passes and the install is checked; with (b) the run is refused before the claim with the wrapper named"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 With the daemon's PATH resolving the install program to Safe-Chain's wrapper, `dipo run` no longer fails at setup with the bare listen EPERM text: as the unknown's answer picks, setup's install step runs through the run's Safe-Chain checking proxy and passes, or work.run and work.preview refuse before any claim with a check that names the wrapper path and says to put the real program first on the daemon PATH
- [ ] #2 With the real install program first on PATH and no Safe-Chain install, setup behaves as today
- [ ] #3 Unit tests in packages/engine/test/worktree/ or packages/engine/test/run/work-run.test.ts cover the wrapper case and the plain case with a fake PATH and fake files
<!-- AC:END -->
