---
id: DIPO-48
title: Start a run for one Ready story
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-11 18:49'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-30
  - DIPO-32
  - DIPO-36
  - DIPO-39
  - DIPO-43
  - DIPO-45
  - DIPO-47
references:
  - packages/engine/src/run/
  - packages/engine/src/db/migrations/
  - packages/cli/src/
  - packages/engine/test/run/
documentation:
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0007-state-database.md
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0010-backlog-and-git-integration.md
  - docs/decisions/0012-story-standard.md
  - docs/decisions/0013-repo-scan-and-script-standard.md
priority: high
type: feature
ordinal: 48000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `work.run` (and `dipo run [ID]`) picks one Ready story from `origin/<base>` or the named one, runs the pickup re-check and claim, sets up the worktree, assembles the prompt, starts a worker host on the tier's model and caps, and reports phases `setup` and `build` as events.

Context: M0 runs one story at a time; `maxAgents` above 1 is refused until M2. References: 0005 section 4 (`work.run` args, result, skips, failed re-check emits `story.state` to Refined), section 5 (`work.assigned`, `work.phase`); 0012 section 2 (Ready to In Progress, eligibility: Ready plus dependencies Done), section 3 (pickup mode); 0010 section 2 (Ready on `origin/<base>`, pending lane-b skip), section 7 (claim); 0013 section 2 (refuse when verify unresolved); 0008 section 9 (tier to caps); 0007 section 4 (`runs`, `run_steps`, `config_snapshots`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

```dipo
branch: "DIPO-48/start-run-one-ready-story"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) with a `success-single` replay, a Ready fixture story goes to In Progress with one claim commit and events `work.assigned`, `work.phase setup`, `work.phase build`."
    - kind: "automated"
      check: "(engine) a story with an open unknown edited in by hand fails the re-check and returns to Refined with the R15 message."
    - kind: "automated"
      check: "(engine) a dependency not Done gives `dependency`; a pending lane-b operation gives `notRunnable`."
    - kind: "manual"
      check: "in a scratch office, set a fixture story Ready through the Backlog CLI and run `dipo run`"
      expect: "prints the started story; `git worktree list` shows `<root>/<ID>` locked."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Migrations add `runs`, `run_steps` and `config_snapshots`.
- [ ] #2 Without `stories`, the engine picks the first Ready story on `origin/<base>` by priority and ordinal whose dependencies are all Done; with `stories`, only those; `maxAgents` above 1 fails with `args.invalid`.
- [ ] #3 Each story not started is a skip with a `SkipReason`: `notReady`, `dependency`, `notRunnable` (including a pending lane-b operation), `collision`, `capacity` or `pickupCheckFailed`.
- [ ] #4 A failed pickup re-check moves the story to Refined through the backlog lane and emits `story.state` with the gate messages in `detail`.
- [ ] #5 The run is refused when the run profile's verify is unresolved, the office statuses are missing (DIPO-36) or the configuration is invalid.
- [ ] #6 A started run records tier, role `developer`, model, start SHA, branch, worktree, slot, budget unit and limit, loop cap, `config_hash` and run profile id.
- [ ] #7 The engine emits `work.assigned`, `work.phase setup`, then `work.phase build` when the worker host starts, and keeps one active run per office.
- [ ] #8 The worker starts with the tier's model, effort and caps, the DIPO-47 system file and task message, and an engine-made session id stored on the run.
- [ ] #9 `dipo run [ID]` prints started and skipped stories with reasons.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S32 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
