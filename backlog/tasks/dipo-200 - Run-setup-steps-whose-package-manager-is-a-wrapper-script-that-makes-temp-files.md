---
id: DIPO-200
title: >-
  Run setup steps whose package manager is a wrapper script that makes temp
  files
status: Ready
assignee: []
created_date: '2026-10-18 08:55'
updated_date: '2026-10-18 14:29'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/worktree/setup.ts
  - packages/engine/src/worktree/claim.ts
  - packages/engine/src/sandbox/step.ts
  - packages/engine/src/sandbox/env.ts
  - packages/engine/src/platform/sandbox-exec.ts
  - packages/engine/test/sandbox/
  - packages/engine/test/platform/
  - packages/engine/test/worktree/setup.test.ts
  - packages/engine/test/worktree/claim.test.ts
  - packages/cli/src/run-command.ts
  - packages/cli/src/run-command.test.ts
priority: high
type: bug
ordinal: 189000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worktree setup step passes when the package manager on the daemon's PATH is a shell wrapper that calls mktemp before it runs the real tool, and when a setup step fails, the message the maintainer sees says how to read that step's output.

Context: M1a run of DIPO-177 on 2026-10-18. `dipo run DIPO-177` printed "setup failed (install (bun install --frozen-lockfile) failed: exit 1: mktemp: mkstemp failed on /var/folders/<user temp>/T/tmp.<x>: Operation not permitted)". The daemon had been started from a shell whose PATH put the maintainer's own Safe-Chain wrapper scripts for bun before the real bun (not the official ~/.safe-chain install that DIPO-82 detects). That wrapper runs `mktemp` with no arguments before it execs the package manager. stepEnv (packages/engine/src/sandbox/env.ts) sets TMPDIR to the step's temp root /tmp/dipo-s-<id>, yet mktemp tried the macOS user temp directory, which the step sandbox does not let it write. With the real bun first on the daemon's PATH, the same setup passed. Why mktemp did not use the step's TMPDIR is not known yet; the first criterion reproduces it. withSrtTmpdir in packages/engine/src/platform/sandbox-exec.ts sets CLAUDE_CODE_TMPDIR and swaps the daemon's TMPDIR to /tmp/dipo-sx- around srt, so it is a likely place to look. The failure is macOS-specific (the user temp directory under /var/folders, Seatbelt), while CI runs the *.ci.test.ts files only on Linux, so the PR states the local macOS run with DIPO_TEST_CI=1 that fails on main and passes after the fix. If the step cannot be fixed with its writes kept inside its temp root, the worker parks with the cause it found. The failure log line shows the step's stdout and stderr only at debug level ([debug only], packages/engine/src/log/logger.ts), so the message gave no hint where to look. The setup-failed text is built in packages/engine/src/worktree/claim.ts, which the CLI and the TUI both show.

```dipo
branch: "DIPO-200/setup-with-temp-file-wrapper"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(sandbox, CI) a setup step whose command is a bash wrapper that runs mktemp with no arguments and then execs the tool passes through the real step runner"
    - kind: "automated"
      check: "(unit) a failed setup step's message names the daemon log command that shows the step's output"
    - kind: "manual"
      check: "(live) on the scratch repo, start the daemon with a PATH whose first bun is a wrapper script that runs mktemp, then run one story"
      expect: "setup passes and the worker starts"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A test (a *.ci.test.ts under packages/engine/test/sandbox/ if it needs the real sandbox) runs a setup step whose command is a bash wrapper script that calls mktemp with no arguments, then execs a stand-in tool; it fails on main as the DIPO-177 setup did and passes after the fix, and the PR states the cause it found
- [ ] #2 The fix keeps the step's temp writes inside its temp root: the step sandbox's write rules are not widened to the user temp directory
- [ ] #3 When a setup step fails, the setup-failed message that `dipo run` prints names the command that shows the step's output (for example `dipo daemon logs --level debug`), and a unit test asserts it
<!-- AC:END -->
