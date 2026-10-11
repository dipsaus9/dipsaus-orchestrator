---
id: DIPO-37
title: Run engine steps on worker code inside the sandbox runtime
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-11 18:49'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-18
  - DIPO-26
references:
  - packages/engine/src/sandbox/
  - packages/engine/src/platform/sandbox.ts
  - packages/engine/test/sandbox/
  - package.json
  - bun.lock
documentation:
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0010-backlog-and-git-integration.md
  - docs/decisions/0014-worker-prompt-assembly.md
priority: high
type: feature
ordinal: 37000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: install, setup, verify and other engine steps that run worker-written code go through a pinned `srt` (`@anthropic-ai/sandbox-runtime`) with a per-run policy translated from the run's paths, and a step refuses to run when `srt` is missing or fails its probe.

Context: security boundary; it fails closed. References: 0008 section 2 "Engine steps on worker-written code" (policy, Linux path rules, probe of `bubblewrap`, `socat`, `ripgrep`, the Ubuntu AppArmor check, fail-closed), open question 10; 0010 amendment (install inside `srt`); 0014 section 3 (verify inside `srt`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

```dipo
branch: "DIPO-37/run-engine-steps-worker-code-inside"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) policy translation for install and verify on darwin and linux path rules (golden files)."
    - kind: "automated"
      check: "(integration, CI only) a sandboxed script cannot write `<main>/.git/x`, cannot read a fake `~/.ssh` file, and cannot open a network connection."
    - kind: "automated"
      check: "(unit) missing `srt` gives `startFailed`."
    - kind: "manual"
      check: "on the maintainer's Mac run `DIPO_TEST_CI=1 bun test packages/engine/test/sandbox`"
      expect: "the write, read and network tests pass on macOS Seatbelt, not only on the Linux CI runner."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `srt` is a pinned dependency and `platform/sandbox.ts` is the only code that spawns it.
- [ ] #2 `translatePolicy(run)` writes an `srt` settings file: writes allowed to the worktree and temp, `denyWrite` on `<main>/.git` and `<worktree>/.git`, `denyRead` on the secret paths of 0008, network closed for verify.
- [ ] #3 The install policy adds `allowWrite` on the configured toolchain caches and network to the office's registry hosts only.
- [ ] #4 On Linux, translated paths are literal: a trailing `/**` is dropped and other globs are skipped with a warning.
- [ ] #5 `probeSandbox()` reports missing `bubblewrap`, `socat` or `ripgrep` on Linux and a stripped user namespace on Ubuntu 24.04 or later.
- [ ] #6 A step whose `srt` is missing, fails the probe or refuses to start returns `startFailed` with the reason and never runs unsandboxed.
- [ ] #7 Steps run with an allowlisted environment, a timeout from configuration, and output captured for storage.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S21 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
