---
id: DIPO-316
title: Isolate every test from the live daemon and run the test suite on macOS in CI
status: Done
assignee: []
created_date: '2026-10-22 21:00'
updated_date: '2026-10-23 11:27'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - '- packages/engine/src/platform/paths.ts'
  - .github/workflows/ci.yml
  - .oxlintrc.json
  - CLAUDE.md
  - bunfig.toml
  - packages/cli/src/index.test.ts
  - packages/cli/src/index.ts
  - packages/client/src/node/index.ts
  - packages/client/src/node/runtime.ts
  - packages/client/test/unit/runtime.test.ts
  - packages/daemon/src/foreground.ts
  - packages/daemon/src/runs.ts
  - packages/daemon/test/
  - packages/daemon/test/integration/dir-refusal.test.ts
  - packages/daemon/test/integration/fixtures/scripted-worker-daemon.ts
  - packages/daemon/test/integration/fixtures/scripted-worker.ts
  - packages/daemon/test/integration/reattach-kill.ci.test.ts
  - packages/daemon/test/unit/runtime-isolation.test.ts
  - packages/engine/src/index.ts
  - packages/engine/src/platform/paths.ts
  - packages/engine/test/backlog/planning.ci.test.ts
  - packages/engine/test/platform/
  - packages/engine/test/platform/paths.test.ts
  - packages/engine/test/run/reattach.ci.test.ts
  - packages/testkit/README.md
  - packages/testkit/src/
  - packages/testkit/src/index.ts
  - packages/testkit/src/runtime.test.ts
  - packages/testkit/src/runtime.ts
  - packages/testkit/src/test-env.test.ts
  - packages/testkit/src/test-env.ts
  - test/lint-boundaries/
  - test/lint-boundaries/fixtures/ci-test-guarded.ts
  - test/lint-boundaries/fixtures/ci-test-unguarded.ts
  - test/lint-boundaries/fixtures/ci-test-wrong-guard.ts
  - test/lint-boundaries/lint-ci-guard.test.ts
  - test/state-dir/state-dir.test.ts
  - tools/lint/oxlint-plugin.js
type: chore
ordinal: 301000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: no test can reach the maintainer's live dipo state. An override of the state or runtime folder that dipo cannot use stops it instead of falling through to the real one. The full suite, with the CI-only tests, runs on macOS in CI as part of the required checks. One CI test kills a real daemon during a live worker and shows that the run re-attaches.

Context:
- `platform/paths.ts` falls back to the real user folders when no override is set.
- For the runtime folder, `paths.ts` passes over a rejected `DIPO_RUNTIME_DIR` to the next candidate, which can be the live daemon's runtime folder. One example of a rejected path is one over the socket path limit.
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
- [x] #1 A `DIPO_RUNTIME_DIR` or `DIPO_HOME` that dipo cannot use makes the daemon and every command refuse with a coded error that names the path and the reason. It never falls through to another candidate.
- [x] #2 The test runner's setup file gives every test process fresh state, log and runtime folders under `DIPO_TMP` before any test runs.
- [x] #3 With the test marker set, `paths.ts` refuses the real home's state and runtime folders, shown by a test. The marker is `DIPO_TEST=1` (design choice, not a maintainer decision).
- [x] #4 A `verify-macos` job in `.github/workflows/ci.yml` runs `bun run verify` with `DIPO_TEST_CI=1` on the macOS runner and is part of `ci-ok`. The CI line in CLAUDE.md names it.
- [x] #5 A CI-only test starts a daemon with a scripted worker host, kills the daemon with SIGKILL during the run, starts the daemon again, and shows that the run re-attaches and ends once.
- [x] #6 A lint rule refuses a `*.ci.test.ts` file whose describe does not register only when `DIPO_TEST_CI` is 1. A fixture in `test/lint-boundaries/` proves the rule.
- [x] #7 `bun run verify` passes, and local `bun test` stays within its time budget.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Done 2026-10-23 (maintainer session): built outside dipo, reviewed by a separate agent (all 7 criteria met; its scope findings are closed by these References). This branch also guards packages/engine/test/backlog/planning.ci.test.ts behind DIPO_TEST_CI, so DIPO-225 no longer needs to. verify-macos is new in ci-ok: its first run on a GitHub macOS runner confirms it. 0017 line approved by the maintainer.
<!-- SECTION:NOTES:END -->
