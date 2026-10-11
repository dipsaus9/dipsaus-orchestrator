---
id: DIPO-43
title: Probe Claude Code and refuse unsafe runs with a sandbox self-test
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-11 18:49'
labels:
  - 'tier:M'
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
documentation:
  - docs/decisions/0008-worker-adapter.md
priority: high
type: feature
ordinal: 43000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: before every launch and resume the engine checks the Claude Code version and login, refuses project settings keys outside the allowlist, and runs a sandbox self-test under the run's policy; any failure refuses the run with `startFailed` and an `engine.notice`.

Context: these checks are fail-closed; a failure is a hold, not a park. References: 0008 section 2 (minimum version 2.1.285, `claude auth status` with `authMethod: "claude.ai"`, project settings allowlist and refused keys, `sandbox` key never allowlisted, stripped keys reappearing, self-test of three probes), section 7 (`startFailed` row), section 11 (capabilities).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

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
      check: "(engine) a failed self-test keeps the story Ready and emits the notice."
    - kind: "manual"
      check: "put `{\"hooks\":{}}` in `.claude/settings.json` of a scratch office and `dipo run` a story"
      expect: "the run is refused and the notice names `hooks` and the file."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `probe()` runs `claude --version` and `claude auth status` and refuses a version below 2.1.285 or any `authMethod` other than `claude.ai`, naming the value.
- [ ] #2 The settings check reads the worktree's `.claude/settings.json` and `.claude/settings.local.json` and refuses any top-level or `permissions.*` key not in the engine safe list or `worker.allowProjectSettings`; a `sandbox` key always refuses.
- [ ] #3 A key stripped at setup that reappears refuses the run.
- [ ] #4 The self-test runs three sandboxed commands under the run's settings: a write under `<main>/.git`, a write to the `<worktree>/.git` pointer, and `gh auth status`; any success, or a self-test that cannot run, refuses the run.
- [ ] #5 A refusal keeps the story Ready, holds new runs on this adapter in every office, and emits an `engine.notice` naming the failed check and the file or key.
- [ ] #6 The checks run before every launch and every resume.
- [ ] #7 Recordings `safety-gitdir-write`, `safety-pointer-write` and `safety-gh-auth` are captured with DIPO-41's tool and replayed in tests.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S27 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
