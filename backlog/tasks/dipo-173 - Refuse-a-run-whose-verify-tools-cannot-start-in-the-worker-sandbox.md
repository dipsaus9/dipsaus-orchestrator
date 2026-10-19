---
id: DIPO-173
title: Refuse a run whose verify tools cannot start in the worker sandbox
status: Done
assignee: []
created_date: '2026-10-17 17:00'
updated_date: '2026-10-19 07:39'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies:
  - DIPO-172
references:
  - packages/engine/src/workers/
  - packages/engine/test/workers/
  - packages/engine/src/run/
  - packages/engine/test/run/
  - packages/engine/src/scan/
priority: medium
type: feature
ordinal: 162000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo refuses a run before the worker starts when a program the office's verify runs needs an interpreter the worker sandbox cannot reach, and names the config key that fixes it, instead of letting the worker spend its turns finding out.

Context: findings 8 and 10 of the DIPO-115 cutover. The first DIPO-105 run (Haiku, tier S) parked budget-exceeded after 61 turns: oxfmt and oxlint start with `#!/usr/bin/env node`, node lived under ~/.nvm, which the default sandbox.toolchainReadPaths (~/.bun, ~/.npm, ~/.cache) does not cover, so format:fix failed with `env: node: No such file or directory` and 96 tests failed. The worker could never get verify green. The dry run's PATH comment lines (the shell wrapper written by packages/engine/src/workers/claude-cli/safe-chain.ts) say an nvm entry was dropped because the worker sandbox cannot read it, but nothing tells the maintainer that verify depends on it.

Today's launch checks (packages/engine/src/workers/claude-cli/launch-checks.ts) cover the probe, project settings, credentials and the session self-test, and a failure holds the adapter in every office (packages/engine/src/workers/hold.ts). A missing verify interpreter belongs to one office. One way to find the programs: follow the resolved verify (the run profile, packages/engine/src/scan/) through `bun run` and `npm run` references in the root package.json scripts, take the first word of each command, and read the interpreter line of each one found in node_modules/.bin. This story depends on the one that accepts sandbox.toolchainReadPaths in office.local.yaml, because the refusal names that file as the fix.

```dipo
branch: "DIPO-173/refuse-unreachable-verify-tools"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a fixture worktree whose verify runs an oxfmt-style bin with #!/usr/bin/env node and node under an unread home directory is refused, with the key named"
    - kind: "automated"
      check: "(unit) the same worktree passes when node's directory is in sandbox.toolchainReadPaths, and a second office's run is not held"
    - kind: "manual"
      check: "(live) on the scratch repo, remove the nvm path from office.local.yaml and run dipo run --dry-run"
      expect: "the dry run names node, the verify program and sandbox.toolchainReadPaths; no worker starts"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Before a worker starts, a launch check lists the programs the office's resolved verify runs, following `bun run <script>` and `npm run <script>` references through the root package.json scripts, and reads the interpreter line of each program found in the worktree's node_modules/.bin
- [x] #2 When an interpreter does not resolve on the worker's planned PATH, or resolves to a file under the home directory outside sandbox.toolchainReadPaths and sandbox.allowRead, the run is refused with one failure per interpreter naming the verify program, the interpreter, where the daemon's PATH finds it, and sandbox.toolchainReadPaths in .dipo/office.local.yaml as the fix
- [x] #3 This refusal does not hold the adapter for other offices: a run in an office whose verify programs resolve still starts
- [x] #4 `dipo run --dry-run` shows the same failure lines for the story it would pick
- [x] #5 Tests cover a verify chain whose node_modules/.bin program needs node outside the read paths (refused, message names the key), the same with node's directory added to sandbox.toolchainReadPaths (passes), and a verify that runs no node_modules/.bin program (passes)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M59G59YGEMBMC0MZC4KPXQZX (Sonnet medium, 64 turns, about $0.95, 7 min) reported done, In Review on the story branch. Two compound commands were auto-denied (G7, DIPO-181). verify-tools.ts follows the office's verify (the stored run profile) through bun run and npm run scripts, reads each node_modules/.bin program's interpreter and refuses the launch with a PlanError before gateLaunch (no adapter hold) when the planned PATH cannot reach it inside the read paths, naming the programs, the interpreter, the directory and sandbox.toolchainReadPaths in .dipo/office.local.yaml. The dry run checks the main checkout.

Review passed. Fixed on top: every session the resumer starts (resume, handoff, review and fix rounds) runs the same check; PATH entries and interpreters are judged on their realpath, so a node symlink or shim into an unreadable directory is refused; a test shows the dry run's problem is the launch's planRefused text. Each new test fails without its fix. Verify outside the sandbox: 3438 pass, 2 skip, 0 fail; DIPO_TEST_CI=1 on workers and run: 725 pass. Left as follow-up: only bun run and npm run are followed (not pnpm, yarn, npx or bun's shorthand); a checkout without node_modules passes the dry run.
<!-- SECTION:NOTES:END -->
