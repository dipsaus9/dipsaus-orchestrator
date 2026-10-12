---
id: DIPO-43
title: Probe Claude Code and refuse unsafe runs with a sandbox self-test
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 14:41'
labels:
  - 'tier:M'
  - test-before-merge
milestone: m-0
dependencies:
  - DIPO-37
  - DIPO-40
  - DIPO-41
references:
  - packages/engine/src/workers/claude-cli/probe.ts
  - packages/engine/src/workers/claude-cli/settings-check.ts
  - packages/engine/src/workers/claude-cli/self-test.ts
  - packages/engine/test/workers/
  - packages/engine/test/recordings/claude-cli/
  - packages/engine/src/workers/hold.ts
  - packages/engine/src/workers/claude-cli/launch-checks.ts
  - packages/engine/src/index.ts
  - tools/recordings/scenarios.ts
  - packages/engine/test/workers/recordings.test.ts
documentation:
  - docs/decisions/0008-worker-adapter.md
priority: high
type: feature
ordinal: 43000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: before every launch and resume the engine checks the Claude Code version and login, refuses project settings keys outside the allowlist, and runs a sandbox self-test under the run's policy; any failure refuses the run with `startFailed` and an `engine.notice`.

Context: these checks are fail-closed; a failure is a hold, not a park. The run itself is wired in DIPO-74, so this story exposes the checks and the hold for that story to call (M0 review, DIPO-15). The third self-test probe is `gh auth token`, which must fail inside the sandbox; `gh auth status` also fails when only the network is closed, so it proves nothing about the token (0008 amendment of 2026-10-12). The live safety captures are a maintainer step, so this story is flagged test-before-merge (M0 review, DIPO-15). References: 0008 section 2 (minimum version 2.1.285, `claude auth status` with `authMethod: "claude.ai"`, project settings allowlist and refused keys, `sandbox` key never allowlisted, stripped keys reappearing, self-test of three probes), section 7 (`startFailed` row), section 11 (capabilities).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-43/probe-claude-code-refuse-unsafe-runs"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) settings check over fixture files with `hooks`, `env`, `enabledPlugins`, `sandbox` and an allowlisted key."
    - kind: "automated"
      check: "(unit) probe refuses version 2.1.284 and `authMethod: \"api-key\"`."
    - kind: "automated"
      check: "(engine) a failed self-test sets the adapter hold with the reason and emits the notice; a later passing check lifts it."
    - kind: "automated"
      check: "(engine) a fixture worktree whose `.claude/settings.json` holds `{\"hooks\":{}}` fails the launch checks with a notice naming `hooks` and the file."
    - kind: "manual"
      check: "maintainer runs `bun run recordings:capture safety-gitdir-write`, `safety-pointer-write` and `safety-gh-token` on the branch"
      expect: "each recording is written with no secret, shows the write or `gh auth token` refused inside the sandbox, and the replay tests pass on it."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `probe()` runs `claude --version` and `claude auth status` and refuses a version below 2.1.285 or any `authMethod` other than `claude.ai`, naming the value.
- [x] #2 The settings check reads the worktree's `.claude/settings.json` and `.claude/settings.local.json` and refuses any top-level or `permissions.*` key not in the engine safe list or `worker.allowProjectSettings`; a `sandbox` key always refuses.
- [x] #3 A key stripped at setup that reappears refuses the run.
- [x] #4 The self-test runs three sandboxed commands under the run's settings: a write under `<main>/.git`, a write to the `<worktree>/.git` pointer, and `gh auth token`; any success, or a self-test that cannot run, refuses the run.
- [x] #5 A refusal returns `startFailed`, sets an adapter hold with the failed check and the file or key, and emits an `engine.notice` naming them; `adapterHeld(adapter)` reports the hold for every office, and an explicit `work.run` repeats the checks and lifts the hold when they pass.
- [x] #6 This story owns the adapter hold: DIPO-51 sets the same hold for `startFailed` outcomes from the CLI, and DIPO-48 and DIPO-74 refuse new runs and keep the story Ready while it holds.
- [x] #7 The checks run before every launch and every resume.
- [ ] #8 Recordings `safety-gitdir-write`, `safety-pointer-write` and `safety-gh-token` are captured live by the maintainer with DIPO-41's tool, committed, and replayed in tests.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S27 (DIPO-15). Before cutover: built by hand-run agents.

Scope additions: packages/engine/src/workers/hold.ts holds the adapter-neutral adapter hold and launch gate (AC #5, #6: DIPO-48, DIPO-51 and DIPO-74 use it without importing Claude code); packages/engine/src/workers/claude-cli/launch-checks.ts composes probe, settings check and self-test before every launch and resume (AC #7); packages/engine/src/index.ts exports them; tools/recordings/scenarios.ts and tools/recordings/recordings.test.ts gain the three safety scenarios the maintainer captures (AC #8).

Implementation (DIPO-43):
- workers/hold.ts (adapter-neutral): AdapterHolds with hold(adapter, failures), lift(adapter) and adapterHeld(adapter) (one instance per daemon, so every office sees it), each raising an engine.notice (adapter.held, error; adapter.released, info) through an injected notify; gateLaunch(adapter, holds, checks) returns startFailed and holds on a failure or a throw, and lifts the hold on a pass. DIPO-51 calls holds.hold for CLI startFailed outcomes; DIPO-48 and DIPO-74 consult adapterHeld. The hold is in memory: after a daemon restart the checks run again before the next launch anyway.
- claude-cli/probe.ts: claude --version and claude auth status through the injected Spawn, on the worker's allowlisted environment; refuses below 2.1.285, any authMethod other than claude.ai, loggedIn false, or output it cannot read, naming the value.
- claude-cli/settings-check.ts: reads .claude/settings.json and .claude/settings.local.json of the worktree; every top-level and permissions.* key must be on the safe list or in worker.allowProjectSettings; sandbox (and sandbox.*) always refuses; a stripped key in the local copy refuses even when the office allows it; bad JSON or a non-object refuses; the notice names key, file and the allowProjectSettings override. stripLocalSettings is exported for DIPO-39's copy.
- claude-cli/self-test.ts: one short Claude Code session (haiku, effort low, tools Bash, new session id, max 6 turns, 180 s) under the run's own claude-settings.json, byte for byte, makes one Bash call: a fixed perl script (so Bash(gh *) and the redirection rules do not stop it before the sandbox) that tries writes to <main>/.git, the worktree admin dir, refs/heads, objects, opens the <worktree>/.git pointer for append, runs gh auth token with output discarded, and writes a control file in the worktree. Results go to a file in the sandbox temp dir. The engine judges from disk outside the sandbox (results file, forbidden files present, pointer changed, control file present) plus the session outcome and permission denials; any write through, gh exit 0, or a self-test that could not run (no results, startFailed, initRejected, crash, timeout, missing probe line, failed control write, pointer naming a gitdir outside <main>/.git/worktrees) refuses. All probe files carry a nonce and are removed afterwards.
- claude-cli/launch-checks.ts: prepareLaunch(spec, ctx, holds, deps) plans the launch or resume, runs probe, then settings, then self-test (each only when the earlier pass) through gateLaunch, and returns the plan only on a pass. It is the one way to a startable plan for launch and resume (AC #7); DIPO-74 and DIPO-51 call it.
- tools/recordings/scenarios.ts: scenarios safety-gitdir-write, safety-pointer-write and safety-gh-token run the self-test command with one probe group each; verify stores the disk facts, the engine verdict and (gh) whether gh auth token works outside the sandbox. test/workers/self-test.test.ts replays them once committed (skipped until then); recordings.test.ts lists them as awaiting capture.

Deviations and open points:
- AC #8 is not checked: the three live recordings are a maintainer step (no live Claude session was started by the implementer).
- The self-test costs one small haiku session per launch and resume.
- The self-test checks more than the three probes of the AC (admin dir, refs, objects, control write) at the DIPO-41 reviewer's request.
- gh auth token exiting 127 (gh not found inside the sandbox) counts as refused; the exit code is kept in the verdict.
- Plugin finding (DIPO-41: user-scope plugins load under --setting-sources project,local): not decided here. The self-test records the plugin count from system/init but does not refuse on it. Options for the maintainer: (a) refuse when system/init lists any plugin; (b) disable them per run by writing enabledPlugins false for each user-enabled plugin into the run settings file (needs a live check that --settings overrides user scope); (c) isolate the worker's config dir (CLAUDE_CONFIG_DIR; needs a live check that the claude.ai login still works); (d) accept with a notice. Each changes 0008 section 2, so it needs an ADR amendment.
- Skills and agents frontmatter check (0008, roles with Agent or Skill) is not built: the M0 developer role has neither tool.

Maintainer test steps (on the branch, macOS, Claude Code >= 2.1.285 logged in with the subscription, gh logged in):
1. bun install && bun run verify -> green; 3 tests skipped (the live safety recordings).
2. DIPO_TMP=$(mktemp -d) bun run recordings:capture safety-gitdir-write safety-pointer-write safety-gh-token -> for each: wrote packages/engine/test/recordings/claude-cli/<name> (...lines) and a checks line with disk.written [], pointerChanged false, controlWritten true, verdict {ok:true,...}; for safety-gh-token verdict.ghExit is non-zero and ghTokenReadableOutsideSandbox is true. The capture runs in a temp fixture repo, not in this repository.
3. bun test packages/engine/test/workers tools/recordings -> all pass, 0 skipped.
4. git add packages/engine/test/recordings/claude-cli/safety-gitdir-write packages/engine/test/recordings/claude-cli/safety-pointer-write packages/engine/test/recordings/claude-cli/safety-gh-token && git commit -m 'test(DIPO-43): record the self-test safety scenarios' && git push. If any verdict is not ok, do not commit; report the checks line.
<!-- SECTION:NOTES:END -->
