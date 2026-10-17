---
id: DIPO-176
title: Pass the full verify inside the worker sandbox on this repository
status: Done
assignee: []
created_date: '2026-10-17 17:00'
updated_date: '2026-10-17 20:05'
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
  - packages/engine/src/workers/claude-cli/plugins.ts
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
- [x] #1 The PR lists each test that fails in a worker-sandbox run of bun run verify on this repository before the change, with its cause, and each one passes there after the change
- [x] #2 Tests that need a home directory, a runtime directory or plugin files use a temp directory under DIPO_TMP or an injected reader, never the real home or the real runtime directory
- [x] #3 The start.test.ts snapshot that differs on a story branch no longer depends on the checked-out branch or on git state outside the test's own temp repository
- [x] #4 A sandboxed run of the full bun run verify with the worker's filesystem read fence passes on macOS, recorded in the task notes with the command, the dipo commit and the result
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Criterion 4, sandboxed verify: on macOS, inside dipo worker session run_01M55PE8B6W4X9TMJEW2SYV7B6 (M1a run 4, dipo built from 5d1cf93, the worker's own run settings and read fence: Claude Code sandbox, reads limited to the worktree, ~/.bun, ~/.npm, ~/.cache, ~/.nvm/versions/node and the run's safe-chain dir), the worker ran `bun run format:fix >/dev/null 2>&1; bun run verify 2>&1 | tail -8`. Result: 3146 pass, 10 skip, 0 fail (3156 tests); verify stops at the first failing stage, so oxfmt, oxlint and tsc passed too. Before the change the same sandbox gave 3136 pass, 10 skip, 10 fail. The 8 skips beyond the 2 seen outside the sandbox: 6 testkit root-length guards (NESTED_ROOT_FITS and LONGEST_ROOT_FITS in testkit temp.test.ts and daemon runtime-isolation.test.ts) skip because the worker's DIPO_TMP is 30 bytes by design (DIPO-118), and 2 most likely PS_RUNS (platform/process.test.ts) and SANDBOX_REFUSES_LOOPBACK (sandbox/safe-chain-proxy.test.ts), inferred, not observed. So the DIPO-109 runtime-isolation guards do not run under the fence.

Failures fixed (10): the five 'work.run starts the worker of a claimed run' tests, the two 'work.preview, the dry run' tests and 'a failed release after a failed host start' in run/start.test.ts, and 'detects Safe-Chain at launch' in run/adapter.test.ts all built the launch context with the default plugin reader, which read /home/maintainer/.claude/plugins/installed_plugins.json and got EPERM under the fence (now an injected empty pluginFiles reader, also in run-office.ts); and platform/paths.test.ts 'falls back to a fresh mkdtemp directory' went over the 100-byte socket limit (now a short mkdtemp alias through the RuntimeDirFs seam, so it passes at any temp root testkit accepts). The 'snapshot differs on a story branch' in criterion 3 was the plugin EPERM: start.test.ts uses no real git.

Delivery: dipo parked the story blocked, asking whether its own sandboxed verify counts for criterion 4 (it does, per the test plan); the work was finished outside the sandbox on DIPO-176/verify-inside-worker-sandbox-finish. Verify outside: 3154 pass, 2 skip, 0 fail.
<!-- SECTION:NOTES:END -->
