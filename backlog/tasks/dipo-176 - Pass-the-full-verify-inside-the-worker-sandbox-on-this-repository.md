---
id: DIPO-176
title: Pass the full verify inside the worker sandbox on this repository
status: Refined
assignee: []
created_date: '2026-10-17 17:00'
updated_date: '2026-10-17 17:00'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/test/run/
  - packages/engine/test/platform/
  - packages/engine/test/worktree/
  - packages/engine/test/workers/
priority: high
type: bug
ordinal: 165000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a dipo worker on this repository gets a green bun run verify inside its own sandbox, so it stops spending turns on test failures that only its sandbox causes.

Context: findings 17, 18 and 22 of the DIPO-115 cutover. In the DIPO-106 and DIPO-107 live runs, bun run verify inside the worker sandbox had the same 10 failing tests, none related to the story, in run/start, work.preview, release, platform/paths and run/adapter: a test reads /home/maintainer/.claude/plugins and gets EPERM (likely a fixture home, as used in packages/engine/test/run/adapter.test.ts, that reaches the real plugin reader in packages/engine/src/workers/claude-cli/plugins.ts: outside the sandbox the read finds nothing, inside it is refused), packages/engine/test/platform/paths.test.ts sees a squatted runtime directory, and a packages/engine/test/run/start.test.ts snapshot differs on a story branch. Both workers reported the failures.

Finding 18 checked: dipo moved both stories to In Review as designed. packages/engine/src/run/verify-commit.ts runs the resolved verify itself through the sandboxed verify step and sets In Review only on green. That step's policy has no home-wide read block (packages/engine/src/sandbox/policy.ts), while the worker's Claude Code sandbox fences reads to the worktree, its temp roots, sandbox.toolchainReadPaths and sandbox.allowRead (packages/engine/src/workers/claude-cli/plan.ts). So the worker saw red where dipo's gate saw green. DIPO-114 made the engine self-verify pass under the verify policy (packages/engine/test/sandbox/self-verify.ci.test.ts); nothing runs the suite under the worker's read fence. If a fix needs a source change, the story is amended to add that path first.

```dipo
branch: "DIPO-176/verify-inside-worker-sandbox"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the tests that read plugin files, the runtime directory and the start snapshot pass with a temp home, a temp runtime directory and a story branch checked out"
    - kind: "manual"
      check: "(live) run bun run verify inside a dipo worker session on this repository, or under srt with the worker's run settings"
      expect: "every test passes; 0 fail"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The PR lists each test that fails in a worker-sandbox run of bun run verify on this repository before the change, with its cause, and each one passes there after the change
- [ ] #2 Tests that need a home directory, a runtime directory or plugin files use a temp directory under DIPO_TMP or an injected reader, never the real home or the real runtime directory
- [ ] #3 The start.test.ts snapshot that differs on a story branch no longer depends on the checked-out branch or on git state outside the test's own temp repository
- [ ] #4 A sandboxed run of the full bun run verify with the worker's filesystem read fence passes on macOS, recorded in the task notes with the command, the dipo commit and the result
<!-- AC:END -->
