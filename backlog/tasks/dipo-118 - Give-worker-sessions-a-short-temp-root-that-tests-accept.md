---
id: DIPO-118
title: Give worker sessions a short temp root that tests accept
status: To Do
assignee: []
created_date: '2026-10-16 11:06'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/workers/claude-cli/plan.ts
  - packages/engine/src/run/temp-dirs.ts
  - packages/engine/src/run/launch.ts
  - packages/engine/src/sandbox/
  - packages/engine/src/platform/supervisor.ts
  - packages/engine/test/
priority: high
type: feature
ordinal: 108000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: tests a worker runs in its own session on this repository (bun test, bun run verify) get a DIPO_TMP short enough for testkit's socket path limit, so the cutover (DIPO-115) can let dipo deliver stories here.

Context: DIPO-109 made packages/testkit/src/temp.ts refuse a DIPO_TMP over 37 bytes after realpath. Sandboxed engine steps already use a short root (mkdtemp /tmp/dipo-s-, packages/engine/src/sandbox/env.ts). A worker session gets no DIPO_TMP from the engine and may write only its worktree and the run temp dir (/tmp/dipo-run-<run id>, packages/engine/src/run/temp-dirs.ts), which is 52 bytes on macOS (/private/tmp/...) and 44 on Linux, so every testkit-based test would be refused there. Found in the DIPO-109 review.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Each worker session gets a short writable temp root (for example /tmp/dipo-t-XXXXXX, at most 37 bytes after realpath on macOS and Linux), passed as DIPO_TMP through the env allowlist and allowed for writes in the worker sandbox; it is removed with the run temp dirs.
- [ ] #2 The worker's sandbox write rules grow by that one directory only; tests show a write elsewhere in /tmp is still denied.
- [ ] #3 Tests cover the env and sandbox settings in the launch plan, the length on both platforms, and cleanup after the run and at the recovery sweep.
<!-- AC:END -->
