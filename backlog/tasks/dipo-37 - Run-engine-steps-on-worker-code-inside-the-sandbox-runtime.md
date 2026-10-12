---
id: DIPO-37
title: Run engine steps on worker code inside the sandbox runtime
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 09:32'
labels:
  - test-before-merge
  - 'tier:L'
milestone: m-0
dependencies:
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

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

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
- [ ] #1 `@anthropic-ai/sandbox-runtime` 0.0.79 is an exact-pinned runtime dependency of `packages/engine`, and `platform/sandbox.ts` is the only engine code that starts a sandboxed step, by spawning `dipo daemon sandbox-exec --policy <file> -- <cmd>` from `process.execPath`.
- [ ] #2 `dipo daemon sandbox-exec` (a hidden `runDaemon` form) reads the policy file, initialises the bundled `srt` library once, runs the wrapped command, forwards stdin, output and signals, stays alive until the command exits, and exits with its code.
- [ ] #3 `translatePolicy(run)` writes an `srt` settings file: writes allowed to the worktree and the step temp root, Unix sockets allowed under the temp root, `denyWrite` on `<main>/.git` and `<worktree>/.git`, `denyRead` on the secret paths of 0008, network closed for verify.
- [ ] #4 Each step gets a fresh temp root `/tmp/dipo-s-<id>`, passed as `TMPDIR` and `DIPO_TMP` and removed after the step.
- [ ] #5 The install policy adds `allowWrite` on `sandbox.toolchainPaths` caches and network to `sandbox.registryHosts` only.
- [ ] #6 On Linux, translated paths are literal: a trailing `/**` is dropped and other globs are skipped with a warning.
- [ ] #7 `probeSandbox()` reports a missing `rg` on macOS and Linux, a missing `bubblewrap` or one older than 0.5 and a missing `socat` on Linux, and a stripped user namespace on Ubuntu 24.04 or later.
- [ ] #8 A step whose sandbox is missing, fails the probe or refuses to start returns `startFailed` with the reason and never runs unsandboxed.
- [ ] #9 Steps run with an allowlisted environment, the `timeouts.scriptMinutes` timeout of their script, and output captured for storage.
- [ ] #10 Each of the four smoke jobs of DIPO-17 runs `dipo daemon sandbox-exec` with a deny-all policy around `true` after installing the probe's dependencies, and every `ubuntu-24.04` job that runs sandbox tests sets `sysctl kernel.apparmor_restrict_unprivileged_userns=0` in `ci.yml`.
- [ ] #11 A CI-only test runs this repository's own verify under the verify policy and passes; an environment guard stops that test from running inside itself.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S21 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
