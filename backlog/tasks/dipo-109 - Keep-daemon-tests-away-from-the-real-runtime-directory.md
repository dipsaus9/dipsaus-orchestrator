---
id: DIPO-109
title: Keep daemon tests away from the real runtime directory
status: To Do
assignee: []
created_date: '2026-10-16 09:39'
updated_date: '2026-10-16 09:47'
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
- [ ] #1 packages/testkit/src/temp.ts refuses, with a message naming the limit, a DIPO_TMP whose socket paths would pass the Unix socket path limit, instead of letting tests fall back; testkit keeps its own copy of the engine's runtime path limits (testkit may not import engine) and a test keeps the two equal.
- [ ] #2 Daemon and client tests that start a daemon set DIPO_RUNTIME_DIR, TMPDIR and XDG_RUNTIME_DIR under the test temp directory, and fail when the daemon reports a runtime directory source other than DIPO_RUNTIME_DIR, so no test daemon can choose the maintainer's real runtime directory ($TMPDIR/dipo or /tmp/dipo-<uid>).
- [ ] #3 A test proves that a long DIPO_TMP is refused and that no test path removes a socket outside the test temp directory.
<!-- AC:END -->
