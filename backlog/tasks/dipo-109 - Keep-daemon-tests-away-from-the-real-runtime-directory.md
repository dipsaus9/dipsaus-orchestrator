---
id: DIPO-109
title: Keep daemon tests away from the real runtime directory
status: Done
assignee: []
created_date: '2026-10-16 09:39'
updated_date: '2026-10-16 10:08'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/platform/paths.ts
  - packages/daemon/test
  - packages/client/test
  - packages/testkit/README.md
  - packages/testkit/src/
priority: high
type: task
ordinal: 99000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: no test can reach or delete the runtime directory of a real daemon, whatever DIPO_TMP is set to.

Context: when DIPO_TMP resolves to more than about 42 bytes (macOS $TMPDIR, an agent scratch directory), the socket path under it would pass the 100-byte limit, so daemon tests fall back to the real runtime directory ($TMPDIR/dipo or /tmp/dipo-<uid>, chosen by packages/engine/src/platform/paths.ts chooseRuntimeDir) and remove its dipo.sock with no liveness check. This happened during the 2026-10-16 milestone review (TL;DR 6, appendix A.6). 17 test files also build temp directories by hand instead of using testkit's makeTempDir.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 packages/testkit/src/temp.ts refuses, with a message naming the limit, a DIPO_TMP whose socket paths would pass the Unix socket path limit, instead of letting tests fall back; testkit keeps its own copy of the engine's runtime path limits (testkit may not import engine) and a test keeps the two equal.
- [x] #2 Daemon and client tests that start a daemon set DIPO_RUNTIME_DIR, TMPDIR and XDG_RUNTIME_DIR under the test temp directory, and fail when the daemon reports a runtime directory source other than DIPO_RUNTIME_DIR, so no test daemon can choose the maintainer's real runtime directory ($TMPDIR/dipo or /tmp/dipo-<uid>).
- [x] #3 A test proves that a long DIPO_TMP is refused and that no test path removes a socket outside the test temp directory.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
testkit/src/runtime.ts copies RUNTIME_PATH_LIMIT and LONGEST_RUNTIME_ENTRY; tempRoot() refuses a DIPO_TMP whose test socket paths would pass 100 bytes (at most 37 bytes after symlinks), naming the limit. daemonTestEnv/isolatedDaemonEnv put DIPO_HOME, DIPO_RUNTIME_DIR, TMPDIR, XDG_RUNTIME_DIR and DIPO_TMP under the test temp dir; withDaemonTempDir/assertTestRuntimeDir fail when the daemon log names another runtime directory. daemon/test/unit/runtime-isolation.test.ts keeps the limits equal (through chooseRuntimeDir), proves the choice stays under the temp dir for the longest accepted root (guarded fs), and scans daemon/client tests that start a daemon. Ran bun run verify (2917 pass) and the five affected CI-only files with DIPO_TEST_CI=1 and DIPO_TMP=/tmp/d109 (7 pass); a foreground run with a 44-byte DIPO_TMP was refused before any daemon started. No live sessions.
<!-- SECTION:NOTES:END -->
