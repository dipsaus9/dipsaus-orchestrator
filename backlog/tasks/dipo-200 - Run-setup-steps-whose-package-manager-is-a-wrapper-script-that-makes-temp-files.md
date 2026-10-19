---
id: DIPO-200
title: >-
  Run setup steps whose package manager is a wrapper script that makes temp
  files
status: Ready
assignee: []
created_date: '2026-10-18 08:55'
updated_date: '2026-10-19 15:14'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/worktree/setup.ts
  - packages/engine/src/worktree/claim.ts
  - packages/engine/src/sandbox/
  - packages/engine/src/sandbox/step.ts
  - packages/engine/src/sandbox/env.ts
  - packages/engine/src/platform/
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

Context: M1a run of DIPO-177 on 2026-10-18. `dipo run DIPO-177` printed "setup failed (install (bun install --frozen-lockfile) failed: exit 1: mktemp: mkstemp failed on /var/folders/<user temp>/T/tmp.<x>: Operation not permitted)". The daemon had been started from a shell whose PATH put the maintainer's own Safe-Chain wrapper scripts for bun before the real bun (not the official ~/.safe-chain install that DIPO-82 detects). That wrapper runs `mktemp` with no arguments before it execs the package manager. stepEnv (packages/engine/src/sandbox/env.ts) sets TMPDIR to the step's temp root /tmp/dipo-s-<id>, yet mktemp tried the macOS user temp directory, which the step sandbox does not let it write. With the real bun first on the daemon's PATH, the same setup passed. Why mktemp did not use the step's TMPDIR is not known yet; the first criterion reproduces it. withSrtTmpdir in packages/engine/src/platform/sandbox-exec.ts sets CLAUDE_CODE_TMPDIR and swaps the daemon's TMPDIR to /tmp/dipo-sx- around srt, so it is a likely place to look. The failure is macOS-specific (the user temp directory under /var/folders, Seatbelt), while CI runs the *.ci.test.ts files only on Linux, and a worker cannot run the real sandbox from inside its own. The worker writes the reproduction and the fix and records the cause it found in its report evidence; the maintainer runs the test on macOS with DIPO_TEST_CI=1 on main and on the branch (manual test plan entry). Since the cause is not known, the fix may land in the step sandbox policy (packages/engine/src/sandbox/) or in the srt wrapping (packages/engine/src/platform/). If the step cannot be fixed with its writes kept inside its temp root, the worker parks with the cause it found. The failure log line shows the step's stdout and stderr only at debug level ([debug only], packages/engine/src/log/logger.ts), so the message gave no hint where to look. The setup-failed text is built in packages/engine/src/worktree/claim.ts, which the CLI and the TUI both show.

Decided fix (2026-10-19 probe, scratchpad diff mktemp-shim.diff): on darwin, withSrtTmpdir in packages/engine/src/platform/sandbox-exec.ts writes a read-only mktemp shim into srt's private /tmp/dipo-sx-* directory and puts that directory first on the step's PATH; the shim adds -p "$TMPDIR" when the call names no template and otherwise execs /usr/bin/mktemp unchanged. A wrapper that calls /usr/bin/mktemp by absolute path still bypasses it; allowing writes to the user temp directory instead would break criterion 2. The trust check that vets the step's PATH must cover the shim directory. Claude worker sessions under srt probably meet the same mktemp behaviour on macOS; that is out of scope here.

```dipo
branch: "DIPO-200/setup-with-temp-file-wrapper"
unknowns:
  - q: "Does a stand-in setup step (a bash wrapper that runs mktemp with no arguments and then execs bun) fail on main the way the DIPO-177 setup did, when run on macOS outside any sandbox through the real step runner with DIPO_TEST_CI=1, and if so, why does mktemp ignore the step's TMPDIR? The maintainer side runs this before the story goes Ready, since a worker cannot run the real step sandbox inside its own; criteria 1 and 2 are then written around the cause found, or the story is dropped if the stand-in does not reproduce it."
    status: "resolved"
    answer: "Yes (probe on 2026-10-19, macOS, outside any sandbox, origin/main 8e6b1c2): a bash wrapper named bun, first on the step's PATH, that runs a bare mktemp fails through runSandboxedStep with the DIPO-177 error. The wrapper sees TMPDIR=/tmp/dipo-s-<id>, so stepEnv, withSrtTmpdir and srt pass TMPDIR through. The cause is macOS /usr/bin/mktemp: with no template (no arguments, only -d/-q/-u, or -t prefix) it builds the path from confstr(_CS_DARWIN_USER_TEMP_DIR), /var/folders/<x>/T, and uses TMPDIR only when that is unavailable; only -p <dir> or an explicit template keeps it out. GNU mktemp on Linux honours TMPDIR. A read-only mktemp shim first on the step's PATH that adds -p \"$TMPDIR\" when no template is given made the probe pass, kept the step unable to write the shim, and left 212 sandbox, setup and platform tests passing."
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the mktemp shim run with a fake mktemp on PATH adds -p \"$TMPDIR\" for no arguments, -d, -q, -u and -t prefix, and passes a template, a relative template or -p through unchanged"
    - kind: "automated"
      check: "(unit) with platform darwin the sandboxed step's PATH starts with the shim directory inside srt's private temp directory, not writable by the step, and with platform linux there is no shim"
    - kind: "automated"
      check: "(sandbox, CI) a setup step whose command is a bash wrapper that runs mktemp with no arguments and then execs the tool passes through the real step runner"
    - kind: "automated"
      check: "(unit) a failed setup step's message names the daemon log command that shows the step's output"
    - kind: "manual"
      check: "(macOS, outside any sandbox) run DIPO_TEST_CI=1 bun test on the new setup-step *.ci.test.ts under packages/engine/test/sandbox/, first on a checkout of main with that test file copied in, then on the story branch"
      expect: "on main the step fails with the mktemp Operation not permitted error the DIPO-177 setup showed; on the branch it passes"
    - kind: "manual"
      check: "(live) on the scratch repo, start the daemon with a PATH whose first bun is a wrapper script that runs mktemp, then run one story"
      expect: "setup passes and the worker starts"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 On darwin the sandboxed step's PATH starts with a read-only mktemp shim in srt's private temp directory that adds -p "$TMPDIR" when the call names no template (no arguments, only -d, -q or -u, or -t prefix) and passes any other call to /usr/bin/mktemp unchanged; on linux no shim is added; unit tests run the shim with a fake mktemp on PATH for each form, and a unit test with platform darwin shows the PATH order and that the step cannot write the shim directory
- [ ] #2 The fix keeps the step's temp writes inside its temp root: the step sandbox's write rules are not widened to the user temp directory, and the trust check that vets the step's PATH covers the shim directory
- [ ] #3 When a setup step fails, the setup-failed message that `dipo run` prints names the command that shows the step's output (for example `dipo daemon logs --level debug`), and a unit test asserts it
<!-- AC:END -->
