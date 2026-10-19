---
id: DIPO-200
title: >-
  Run setup steps whose package manager is a wrapper script that makes temp
  files
status: Done
assignee: []
created_date: '2026-10-18 08:55'
updated_date: '2026-10-19 22:43'
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
  - packages/daemon/src/runs.ts
  - packages/engine/test/worktree/setup-harness.ts
priority: high
type: bug
ordinal: 189000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worktree setup step passes when the package manager on the daemon's PATH is a shell wrapper that calls mktemp before it runs the real tool, and when a setup step fails, the message the maintainer sees says how to read that step's output.

Context: M1a run of DIPO-177 on 2026-10-18. `dipo run DIPO-177` printed "setup failed (install (bun install --frozen-lockfile) failed: exit 1: mktemp: mkstemp failed on /var/folders/<user temp>/T/tmp.<x>: Operation not permitted)". The daemon had been started from a shell whose PATH put the maintainer's own Safe-Chain wrapper scripts for bun before the real bun (not the official ~/.safe-chain install that DIPO-82 detects). That wrapper runs `mktemp` with no arguments before it execs the package manager. stepEnv (packages/engine/src/sandbox/env.ts) sets TMPDIR to the step's temp root /tmp/dipo-s-<id>, yet mktemp tried the macOS user temp directory, which the step sandbox does not let it write. With the real bun first on the daemon's PATH, the same setup passed. The cause (probe on 2026-10-19, macOS, main at 8e6b1c2): the wrapper saw TMPDIR=/tmp/dipo-s-<id>, so stepEnv, withSrtTmpdir and srt pass TMPDIR through, but macOS /usr/bin/mktemp without a template (no arguments, only -d, -q or -u, or -t prefix) builds its path from confstr(_CS_DARWIN_USER_TEMP_DIR), /var/folders/<x>/T, and ignores TMPDIR; with -p <dir> or an explicit template it stays in that directory. GNU mktemp on Linux honours TMPDIR. The failure is macOS-specific (the user temp directory under /var/folders, Seatbelt), while CI runs the *.ci.test.ts files only on Linux, and a worker cannot run the real sandbox from inside its own, so the maintainer runs the setup-step CI test on macOS with DIPO_TEST_CI=1 on main and on the branch (manual test plan entry). The failure log line shows the step's stdout and stderr only at debug level ([debug only], packages/engine/src/log/logger.ts), so the message gave no hint where to look. The setup-failed text is built in packages/engine/src/worktree/claim.ts, which the CLI and the TUI both show.

Decided fix: on darwin, runSandboxExec in packages/engine/src/platform/sandbox-exec.ts makes srt's private /tmp/dipo-sx-* directory before checkTrust (today it makes it after checkTrust, which vets env PATH while the directory does not exist yet), writes a read-only mktemp shim into a directory inside it, puts that directory first on the step's PATH and passes that shim-prefixed PATH to checkTrust, so the trust check vets the shim directory like every other PATH entry. withSrtTmpdir keeps its one job of setting CLAUDE_CODE_TMPDIR. The shim text is built from the path of the real mktemp (/usr/bin/mktemp on darwin), so unit tests build it with a recording fake in place of /usr/bin/mktemp, not with a fake on PATH. The shim adds -p "$TMPDIR" when the call names neither a template nor -p (no arguments, only -d, -q or -u, or -t prefix) and passes every other call to the real mktemp unchanged, an explicit -p dir as given and never with a second -p. That the step cannot write the shim directory is shown by the trust check or the policy in a unit test, not by a real sandbox. A wrapper that calls /usr/bin/mktemp by absolute path still bypasses the shim; allowing writes to the user temp directory instead would break criterion 2. Claude worker sessions under srt probably meet the same mktemp behaviour on macOS; that is out of scope here.

```dipo
branch: "DIPO-200/setup-with-temp-file-wrapper"
unknowns:
  - q: "Does a stand-in setup step (a bash wrapper that runs mktemp with no arguments and then execs bun) fail on main the way the DIPO-177 setup did, when run on macOS outside any sandbox through the real step runner with DIPO_TEST_CI=1, and if so, why does mktemp ignore the step's TMPDIR? The maintainer side runs this before the story goes Ready, since a worker cannot run the real step sandbox inside its own; criteria 1 and 2 are then written around the cause found, or the story is dropped if the stand-in does not reproduce it."
    status: "resolved"
    answer: "Yes (probe on 2026-10-19, macOS, outside any sandbox, main at 8e6b1c2): a bash wrapper named bun, first on the step's PATH, that runs a bare mktemp fails through runSandboxedStep with the DIPO-177 error. The wrapper sees TMPDIR=/tmp/dipo-s-<id>, so stepEnv, withSrtTmpdir and srt pass TMPDIR through. The cause is macOS /usr/bin/mktemp: with no template (no arguments, only -d/-q/-u, or -t prefix) it builds the path from confstr(_CS_DARWIN_USER_TEMP_DIR), /var/folders/<x>/T, and uses TMPDIR only when that is unavailable; only -p <dir> or an explicit template keeps it out. GNU mktemp on Linux honours TMPDIR. A read-only mktemp shim first on the step's PATH that adds -p \"$TMPDIR\" when no template is given made the probe pass and kept the step unable to write the shim."
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the shim setup, which takes the base directory of the private directory as a parameter (/tmp in production) so the test makes it under DIPO_TMP, with platform darwin makes the private directory before the trust check, puts the shim directory first on PATH and gives the trust check that PATH, which finds the shim directory outside every path the policy makes writable; with platform linux PATH is unchanged and there is no shim"
    - kind: "automated"
      check: "(unit) the shim built with a recording fake in place of /usr/bin/mktemp adds -p \"$TMPDIR\" for no arguments, -d, -q, -u and -t prefix, and passes a template, a relative template and an explicit -p dir to the fake unchanged, with no second -p"
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
- [x] #1 On darwin, runSandboxExec in packages/engine/src/platform/sandbox-exec.ts makes its private /tmp/dipo-sx-* directory before checkTrust, writes a read-only mktemp shim into a directory inside it and puts that directory first on the step's PATH; on linux no shim is added. The shim text is built from the real mktemp path, adds -p "$TMPDIR" when the call names neither a template nor -p (no arguments, only -d, -q or -u, or -t prefix) and passes every other call, an explicit -p dir among them, to the real mktemp unchanged; unit tests in packages/engine/test/platform/ build the shim with a recording fake in place of /usr/bin/mktemp and check the arguments it gets for each form, and a *.ci.test.ts under packages/engine/test/sandbox/ runs a setup step whose command is a bash wrapper that calls mktemp with no arguments and then execs a stand-in tool through the real step runner and asserts that it passes
- [x] #2 The fix keeps the step's temp writes inside its temp root: the step sandbox's write rules are not widened to the user temp directory, and checkTrust gets the shim-prefixed PATH, so it vets the shim directory; a unit test with platform darwin shows the shim directory first on PATH and the trust check finding it outside every path the policy makes writable
- [x] #3 When a setup step fails, the setup-failed message that `dipo run` prints names the command that shows the step's output (for example `dipo daemon logs --level debug`), and a unit test asserts it
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M5B3Q5AFCEKF4DH6ASBDSZK4 (Sonnet, 29 turns, about $0.50, 4 min) reported done, In Review; two sed -i calls were auto-denied (G7). On macOS, runSandboxExec makes the private /tmp/dipo-sx-* directory (base as a parameter) and a read-only mktemp shim in it before checkTrust, which vets the shim-prefixed PATH. The shim, built from /usr/bin/mktemp, adds -p "$TMPDIR" to a template-less call (no arguments, -d, -q, -u, -t prefix, and the long --directory, --quiet, --dry-run) and passes templates, -p dir and --tmpdir through unchanged; Linux is unchanged. Fixed on top: (1) the CI wrapper test put its fake package manager in a bin/ inside the worktree, which the trust check rightly refused; it now lives outside, and the test passes on the branch and fails with main's sandbox-exec.ts with the original mktemp Operation not permitted error. (2) Review (blocking): warn lines never show stdout and stderr, so the hint `dipo daemon logs --level debug` showed nothing; setup now also logs the output tails at debug (wired in packages/daemon/src/runs.ts) and the notice names `dipo daemon log-level debug`, start the story again, then `dipo daemon logs --level debug`, with a test that renders both lines. (3) The long mktemp options above (review advisory). References widened at close: packages/daemon/src/runs.ts and packages/engine/test/worktree/setup-harness.ts. Not done (advisory): a test that the shim file exists when the trust callback runs. Verify outside the sandbox: 3753 tests, 0 fail; DIPO_TEST_CI=1 sandbox, platform, worktree, cli and daemon tests pass (693). Review and re-review passed apart from the References, now declared.
<!-- SECTION:NOTES:END -->
