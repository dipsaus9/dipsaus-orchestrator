---
id: DIPO-316
title: Isolate every test from the live daemon and run the test suite on macOS in CI
status: Refined
assignee: []
created_date: '2026-10-22 21:00'
updated_date: '2026-10-22 21:00'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/platform/paths.ts
  - packages/testkit/src/
  - packages/daemon/test/
  - packages/engine/test/platform/
  - packages/engine/test/run/reattach.ci.test.ts
  - .github/workflows/ci.yml
  - CLAUDE.md
  - tools/lint/oxlint-plugin.js
  - .oxlintrc.json
  - test/lint-boundaries/
type: chore
ordinal: 301000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: no test can reach the maintainer's live dipo state. An override of the state or runtime folder that dipo cannot use stops it instead of falling through to the real one. The full suite, with the CI-only tests, runs on macOS in CI as part of the required checks. One CI test kills a real daemon during a live worker and shows that the run re-attaches.

Context:
- `platform/paths.ts` falls back to the real user folders when no override is set.
- For the runtime folder, `paths.ts` passes over a rejected `DIPO_RUNTIME_DIR` to the next candidate, which can be the live daemon's runtime folder. One example of a rejected path is one over the socket path limit. This is how a long `DIPO_TMP` once removed the real socket.
- Isolation is opt-in (`testkit/src/env.ts`, `testkit/src/runtime.ts`). The setup file that the test runner loads before every test (`packages/testkit/src/listener-guard.ts`) checks only listeners.
- The `verify` job with `DIPO_TEST_CI=1` runs only on Linux. The macOS lanes run the build and the smoke test, not the suite, though the maintainer runs the daemon and the boxes on macOS.
- Re-attach is tested in-process (`engine/test/run/reattach.ci.test.ts`), and no test kills a real daemon.
- A `*.ci.test.ts` file can forget its CI guard. DIPO-225 fixes the known case.

```dipo
branch: "DIPO-316/isolate-tests-macos-ci"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A `DIPO_RUNTIME_DIR` or `DIPO_HOME` that dipo cannot use makes the daemon and every command refuse with a coded error that names the path and the reason. It never falls through to another candidate.
- [ ] #2 The test runner's setup file gives every test process fresh state, log and runtime folders under `DIPO_TMP` before any test runs.
- [ ] #3 With the test marker set, `paths.ts` refuses the real home's state and runtime folders, shown by a test. The marker is `DIPO_TEST=1` (design choice, not a maintainer decision).
- [ ] #4 A `verify-macos` job in `.github/workflows/ci.yml` runs `bun run verify` with `DIPO_TEST_CI=1` on the macOS runner and is part of `ci-ok`. The CI line in CLAUDE.md names it.
- [ ] #5 A CI-only test starts a daemon with a scripted worker host, kills the daemon with SIGKILL during the run, starts the daemon again, and shows that the run re-attaches and ends once.
- [ ] #6 A lint rule refuses a `*.ci.test.ts` file whose describe does not register only when `DIPO_TEST_CI` is 1. A fixture in `test/lint-boundaries/` proves the rule.
- [ ] #7 `bun run verify` passes, and local `bun test` stays within its time budget.
<!-- AC:END -->
