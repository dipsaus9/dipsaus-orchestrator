---
id: DIPO-37
title: Run engine steps on worker code inside the sandbox runtime
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 12:53'
labels:
  - test-before-merge
  - 'tier:L'
milestone: m-0
dependencies:
  - DIPO-17
  - DIPO-18
  - DIPO-23
  - DIPO-26
references:
  - packages/engine/src/sandbox/
  - packages/engine/src/platform/sandbox.ts
  - packages/engine/test/sandbox/
  - package.json
  - bun.lock
  - packages/engine/package.json
  - packages/daemon/src/
  - .github/workflows/ci.yml
  - packages/engine/src/index.ts
  - scripts/build.ts
  - scripts/build.test.ts
  - packages/cli/src/index.ts
  - packages/cli/src/index.test.ts
  - .oxfmtrc.json
documentation:
  - docs/decisions/0004-language-and-runtime.md
  - docs/decisions/0006-daemon-and-ipc.md
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0010-backlog-and-git-integration.md
  - docs/decisions/0014-worker-prompt-assembly.md
priority: high
type: feature
ordinal: 37000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: install, setup, verify and other engine steps that run worker-written code go through the bundled `srt` (`@anthropic-ai/sandbox-runtime` 0.0.79) by way of `dipo daemon sandbox-exec`, with a per-run policy translated from the run's paths, and a step refuses to run when the sandbox is missing or fails its probe.

Context: security boundary; it fails closed. `srt` is a Node CLI whose library form is a process-wide singleton with the network proxy in the wrapping process, so dipo bundles it as a library and runs each step in its own process through the hidden `runDaemon` form `dipo daemon sandbox-exec --policy <file> -- <cmd>`, which stays alive while the command runs (maintainer decision D11, DIPO-15; 0004, 0006 and 0008 amendments of 2026-10-12). DIPO-17's self-check only proves the library loads; this story adds a real `sandbox-exec` run to the four smoke jobs. Each step gets a short temp root that the policy opens for writes and Unix sockets, passed as `TMPDIR` and `DIPO_TMP`, so this repository's own tests (which create sockets under `DIPO_TMP`, DIPO-18) pass when dipo verifies itself after cutover. References: 0008 section 2 "Engine steps on worker-written code" (policy, Linux path rules, probe, the Ubuntu AppArmor check, fail-closed) and its 2026-10-12 amendment (`rg` on macOS and Linux), open question 10; 0010 amendment (install inside `srt`); 0014 section 3 (verify inside `srt`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-37/run-engine-steps-worker-code-inside"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) policy translation for install and verify on darwin and linux path rules, including the step temp root (golden files)."
    - kind: "automated"
      check: "(integration, CI only) a sandboxed script cannot write `<main>/.git/x`, cannot read a fake `~/.ssh` file, and cannot open a network connection, but can create a Unix socket under the step temp root."
    - kind: "automated"
      check: "(integration, CI only) `dipo daemon sandbox-exec` passes stdin, output and the exit code through and stays alive until the command exits."
    - kind: "automated"
      check: "(CI only) this repository's verify passes under the verify policy, with a guard so the test does not start itself again."
    - kind: "automated"
      check: "(unit) a missing sandbox or `rg`, and `bubblewrap` 0.4.1, give `startFailed` with the reason."
    - kind: "manual"
      check: "on the maintainer's Mac run `DIPO_TEST_CI=1 bun test packages/engine/test/sandbox`"
      expect: "the write, read, socket and network tests pass on macOS Seatbelt, not only on the Linux CI runner."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `@anthropic-ai/sandbox-runtime` 0.0.79 is an exact-pinned runtime dependency of `packages/engine`, and `platform/sandbox.ts` is the only engine code that starts a sandboxed step, by spawning `dipo daemon sandbox-exec --policy <file> -- <cmd>` from `process.execPath`.
- [x] #2 `dipo daemon sandbox-exec` (a hidden `runDaemon` form) reads the policy file, initialises the bundled `srt` library once, runs the wrapped command, forwards stdin, output and signals, stays alive until the command exits, and exits with its code.
- [x] #3 `translatePolicy(run)` writes an `srt` settings file: writes allowed to the worktree and the step temp root, Unix sockets allowed under the temp root, `denyWrite` on `<main>/.git` and `<worktree>/.git`, `denyRead` on the secret paths of 0008, network closed for verify.
- [x] #4 Each step gets a fresh temp root `/tmp/dipo-s-<id>`, passed as `TMPDIR` and `DIPO_TMP` and removed after the step.
- [x] #5 The install policy adds `allowWrite` on `sandbox.toolchainPaths` caches and network to `sandbox.registryHosts` only.
- [x] #6 On Linux, translated paths are literal: a trailing `/**` is dropped and other globs are skipped with a warning.
- [x] #7 `probeSandbox()` reports a missing `rg` on macOS and Linux, a missing `bubblewrap` or one older than 0.5 and a missing `socat` on Linux, and a stripped user namespace on Ubuntu 24.04 or later.
- [x] #8 A step whose sandbox is missing, fails the probe or refuses to start returns `startFailed` with the reason and never runs unsandboxed.
- [x] #9 Steps run with an allowlisted environment, the `timeouts.scriptMinutes` timeout of their script, and output captured for storage.
- [x] #10 Each of the four smoke jobs of DIPO-17 runs `dipo daemon sandbox-exec` with a deny-all policy around `true` after installing the probe's dependencies, and every `ubuntu-24.04` job that runs sandbox tests sets `sysctl kernel.apparmor_restrict_unprivileged_userns=0` in `ci.yml`.
- [x] #11 A CI-only test runs this repository's own verify under the verify policy and passes; an environment guard stops that test from running inside itself.
- [x] #12 Inside the compiled `dipo` binary, `srt` finds its `apply-seccomp` helper on Linux (DIPO-17 found it missing: a warning at init); the smoke job's `sandbox-exec` check fails when the helper is missing or `srt` warns about it.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S21 (DIPO-15). Before cutover: built by hand-run agents.

DIPO-37 implementation (hand-run agent).

Shape: engine/src/sandbox/ holds the pure parts (translatePolicy, evaluateProbe, stepEnv, runSandboxedStep with injected Clock and SandboxHost). engine/src/platform/sandbox.ts is the only code that starts a sandboxed step: it spawns `dipo daemon sandbox-exec --policy <file> -- <cmd>` from process.execPath (Bun plus the CLI entry when running from source) in its own process group, makes the temp root with mkdtemp(`/tmp/dipo-s-`), and writes the policy as a sibling `<root>.policy.json` (0600, O_EXCL). engine/src/platform/sandbox-exec.ts is the inside of the hidden form: it validates the policy with srt's own schema, runs probeSandbox, initialises srt once, refuses on any srt dependency error or warning, wraps the argv, runs it with this process's stdio, forwards SIGINT/SIGTERM/SIGHUP, exits with the command's code (128+signal). A refusal is exit 125 plus one `dipo sandbox-exec: refused: <reason>` stderr line; the step maps that to startFailed.

Extra references, and why:
- packages/cli/src/index.ts and its test: `sandbox-exec` had to join the CLI's DAEMON_FORMS so `dipo daemon sandbox-exec` reaches runDaemon.
- .oxfmtrc.json: on Linux srt bind-mounts /dev/null over missing "dangerous" names in the working directory (.mcp.json, .vscode, .idea, .bashrc ...) while the command runs; oxfmt then fails to read `.mcp.json`. Ignoring `.mcp.json` lets this repository's verify pass under the verify policy (AC #11).

Findings and deviations:
- Security fix outside the ACs: a compiled Bun binary loads bunfig.toml (preload scripts) and .env from its working directory by default. sandbox-exec runs with the worktree as cwd, so a planted bunfig.toml ran code outside the sandbox (reproduced). scripts/build.ts now passes --no-compile-autoload-{bunfig,dotenv,tsconfig,package-json}; build.test.ts and a smoke step check it.
- AC #12: srt resolves apply-seccomp relative to its module, which inside the binary is /$bunfs. The helpers for x64 and arm64 are imported `with { type: "file" }` (embedded, about 1.4 MB per binary), copied into a private mkdtemp dir at run time and passed as seccomp.applyPath. Verified in an ubuntu:24.04 arm64 container: deny-all blocks an abstract Unix socket; a build with a bogus helper path is refused with "seccomp not available"; missing bwrap is refused.
- srt overrides the command's TMPDIR with /tmp/claude unless CLAUDE_CODE_TMPDIR is set in the wrapping process; sandbox-exec sets it from the step's TMPDIR so TMPDIR and DIPO_TMP both point at the step temp root (AC #4).
- Linux Unix sockets: srt's seccomp filter cannot filter by path, so the Linux policy sets allowAllUnixSockets: true (macOS uses allowUnixSockets: [tempRoot]). On Linux a step can therefore connect to any Unix socket it can reach on the filesystem. Open question for the maintainer.
- macOS self-verify: srt's Seatbelt profile refuses to exec the setuid /bin/ps that DIPO-23's process probe uses, so 4 process/daemon tests fail when this repository verifies itself under the sandbox on macOS. The AC #11 test is therefore Linux only (it runs in the CI verify job); everything else in verify passes on macOS under the sandbox. Open question: should the macOS process probe move off /bin/ps (for example libproc through bun:ffi) before cutover?
- toolchainPaths are opened for writes as configured; the default `~/.bun` includes `~/.bun/bin`, so an install step could replace the bun binary. Open question: narrow the defaults to cache directories (for example `~/.bun/install/cache`)?
- srt always adds /tmp/claude to the writable paths (built in), shared by every sandboxed step.

Manual test on macOS (maintainer):
1. `brew install ripgrep` (the probe needs rg on macOS too, 0008 amendment).
2. In the worktree: `bun install && DIPO_TEST_CI=1 bun test packages/engine/test/sandbox` -> all pass: write/read/socket/network/TMPDIR tests and the sandbox-exec passthrough tests (the self-verify test only registers on Linux).
3. `bun run build && D=$PWD/dist/dipo`, then:
   T=$(mktemp -d /tmp/dipo-XXXXXX); mkdir -p $T/home/.ssh $T/main/.git $T/wt $T/s; echo SECRET > $T/home/.ssh/id
   printf '{"network":{"allowedDomains":[],"deniedDomains":[],"strictAllowlist":true,"allowUnixSockets":["%s/s"]},"filesystem":{"denyRead":["%s/home/.ssh"],"allowWrite":["%s/wt","%s/s"],"denyWrite":["%s/main/.git"]}}\n' $T $T $T $T $T > $T/p.json
   cd $T/wt
   $D daemon sandbox-exec --policy $T/p.json -- sh -c 'echo hi > ok && cat ok'      -> hi, exit 0
   $D daemon sandbox-exec --policy $T/p.json -- sh -c 'echo x > ../main/.git/x'     -> Operation not permitted, exit 1
   $D daemon sandbox-exec --policy $T/p.json -- cat $T/home/.ssh/id                 -> Operation not permitted, exit 1
   $D daemon sandbox-exec --policy $T/p.json -- curl -sS -m 5 https://example.com   -> CONNECT tunnel failed, response 403
   $D daemon sandbox-exec --policy $T/p.json -- sh -c 'exit 7'; echo $?             -> 7
   echo piped | $D daemon sandbox-exec --policy $T/p.json -- cat                    -> piped
   PATH=/usr/bin:/bin $D daemon sandbox-exec --policy $T/p.json -- true; echo $?    -> "dipo sandbox-exec: refused: ripgrep (rg) is not installed or not on PATH", 125
<!-- SECTION:NOTES:END -->
