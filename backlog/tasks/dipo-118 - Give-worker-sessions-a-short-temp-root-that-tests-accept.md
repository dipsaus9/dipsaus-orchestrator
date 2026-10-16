---
id: DIPO-118
title: Give worker sessions a short temp root that tests accept
status: Done
assignee: []
created_date: '2026-10-16 11:06'
updated_date: '2026-10-16 11:54'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/run/temp-dirs.ts
  - packages/engine/src/run/launch.ts
  - packages/engine/src/sandbox/
  - packages/engine/src/platform/supervisor.ts
  - packages/engine/test/
  - packages/engine/src/workers/
  - packages/engine/src/platform/sandbox.ts
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0006-daemon-and-ipc.md
priority: high
type: feature
ordinal: 108000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: tests a worker runs in its own session on this repository (bun test, bun run verify) get a DIPO_TMP short enough for testkit's socket path limit, so the cutover (DIPO-115) can let dipo deliver stories here.

Context: DIPO-109 made packages/testkit/src/temp.ts refuse a DIPO_TMP over 37 bytes after realpath. Sandboxed engine steps already use a short root (mkdtemp of /tmp/dipo-s-, STEP_TEMP_PREFIX in packages/engine/src/platform/sandbox.ts; packages/engine/src/sandbox/env.ts sets TMPDIR and DIPO_TMP to it). A worker session gets no DIPO_TMP (ENV_ALLOWLIST in packages/engine/src/workers/claude-cli/plan.ts) and may write only its worktree and the run temp dir (/tmp/dipo-run-<run id>, packages/engine/src/run/temp-dirs.ts), which is 52 bytes on macOS (/private/tmp/...) and 44 on Linux, so every testkit-based test would be refused there. The run temp dir reaches the plan through RunLaunchPaths (packages/engine/src/workers/port.ts) and the adapter context; workerWritableRoots (packages/engine/src/workers/claude-cli/self-test.ts, used by launch-checks.ts) is the check that refuses tools or PATH directories under a worker-writable root. 0008 section 2 lists the worker environment by name and limits writes to the worktree and the sandbox temp directory; the 0006 decision 7 DIPO-102 amendment names only <tmpRoot>/dipo-run-<run id> for the sweep. Found in the DIPO-109 review.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Each worker session gets a short writable temp root (for example /tmp/dipo-t-XXXXXX, at most 37 bytes after realpath on macOS and Linux). The engine sets DIPO_TMP to it in the plan's environment, as it does DIPO_RUN; it is never copied from the daemon's environment.
- [x] #2 The worker's sandbox write rules grow by that one directory only, and it is in workerWritableRoots; tests show a write elsewhere in /tmp is still denied.
- [x] #3 The directory is removed with the run's temp dirs and by the recovery sweep, which maps it to its run (for example an owner and run file inside it) and keeps the DIPO-102 removal rules unchanged: a real directory owned by the user, no symlinks, an owner file naming this daemon's database.
- [x] #4 Tests cover the plan's env and sandbox settings, the length on both platforms and cleanup; a CI test under the worker's srt policy (or a recorded live check on the scratch repository) shows a testkit test that starts a daemon passing with the new DIPO_TMP, or the task notes record what still blocks it.
- [x] #5 Dated notes for 0008 section 2 (DIPO_TMP in the worker environment, one more write path) and for the 0006 decision 7 DIPO-102 sweep are in the PR for the maintainer's approval.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-16 (implementer): Each run gets <tmpRoot>/dipo-t-<first 10 hex of sha256(run id)> (30 bytes on macOS /private/tmp, 22 on Linux /tmp), made 0700 before every launch and resume with a .dipo-run file and the .dipo-owner file. The plan sets DIPO_TMP to it (never from the daemon env), adds it as the only extra allowWrite and as sandbox.network.allowUnixSockets, and workerWritableRoots includes it. The DIPO-102 sweep maps it to its run (run file checked against the name, or from the run's dipo-run dir) and removes it under the same rules. Criterion 4: CI test packages/engine/test/workers/short-temp.ci.test.ts runs the plan's sandbox block through dipo daemon sandbox-exec (srt 0.0.79): short root and run temp dir writable, a sibling in /tmp blocked (both platforms); on macOS packages/client/test/integration/daemon.test.ts passes inside with the plan's DIPO_TMP (2 pass, run locally with DIPO_TEST_CI=1), fails without allowUnixSockets, and a socket bind under the run temp dir is refused (EPERM). Still blocking: on Linux srt blocks all Unix sockets unless allowAllUnixSockets (seccomp, from srt source; not run live), so daemon tests in a Linux worker fail; macOS only is covered. Unverified live (no live session run): that Claude Code passes sandbox.network.allowUnixSockets from --settings to its sandbox, and that blockReadsOutsideWorkingDirectories leaves the short root readable to sandboxed commands; check in the first DIPO-115 live run. No live Haiku session was run.
<!-- SECTION:NOTES:END -->
