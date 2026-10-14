---
id: DIPO-74
title: Start the worker for a claimed run
status: Done
assignee: []
created_date: '2026-10-12 09:22'
updated_date: '2026-10-14 10:15'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-39
  - DIPO-43
  - DIPO-44
  - DIPO-45
  - DIPO-47
  - DIPO-48
references:
  - packages/engine/src/run/
  - packages/engine/test/run/
  - packages/engine/src/workers/claude-cli/adapter.ts
  - packages/engine/src/features.ts
  - packages/daemon/src/foreground.ts
  - packages/daemon/test/
  - packages/contract/src/office.ts
  - packages/contract/src/fixtures.ts
  - packages/contract/src/version.ts
  - packages/contract/src/work.test.ts
  - packages/contract/schema/reads.schema.json
  - packages/engine/src/workers/port.ts
  - packages/engine/src/workers/types.ts
  - packages/engine/src/workers/claude-cli/plan.ts
  - packages/engine/src/worktree/claim.ts
  - packages/engine/src/worktree/feature.ts
  - packages/engine/src/worktree/records.ts
  - packages/engine/src/gate/store/feature.ts
  - packages/engine/src/index.ts
  - packages/daemon/src/runs.ts
  - packages/cli/src/run-command.ts
  - packages/cli/src/run-command.test.ts
  - packages/cli/src/index.ts
  - packages/engine/src/workers/hold.ts
  - docs/decisions/0005-command-and-event-model.md
  - >-
    backlog/tasks/dipo-51 -
    Handle-worker-outcomes-and-resume-a-crashed-session-once.md
  - >-
    backlog/tasks/dipo-52 -
    Derive-story-and-work-views-snapshots-and-a-plain-watch-command.md
documentation:
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0006-daemon-and-ipc.md
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0010-backlog-and-git-integration.md
  - docs/decisions/0014-worker-prompt-assembly.md
priority: high
type: feature
ordinal: 48500
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: after `work.run` claims a story, the engine sets up the worktree, runs the launch checks, assembles the prompt, starts a worker host on the tier's model and caps with an engine-made session id, starts ingesting the host's events, and emits `work.phase build`; a setup or launch-check failure releases the claim and leaves the story Ready.

Context: split from DIPO-48 in the M0 review (DIPO-15); DIPO-48 keeps selection, refusals, the pickup re-check and the claim. M0 runs one story at a time. Ingestion is triggered by the host's `advanced` announcement with a 1 s `stat` poll as fallback (DIPO-45); this story wires it to each started run. References: 0005 section 5 (`work.phase`); 0008 sections 2 (launch checks before every launch), 7 (`startFailed`), 9 (tier to caps); 0010 section 7 (claim, then setup), section 8 (setup), failure case "Setup fails"; 0014 section 1 (system file and task message); 0006 decision 8 (worker host).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-74/start-worker-claimed-run"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) with a `success-single` replay through `FakeProcess`, a Ready fixture story goes to In Progress with one claim commit, events `work.assigned`, `work.phase setup`, `work.phase build`, and the replay's usage ingested."
    - kind: "automated"
      check: "(engine) a failed sandbox self-test removes the worktree, deletes the branch at its start SHA, keeps the story Ready and sets the adapter hold."
    - kind: "automated"
      check: "(engine) the worker host receives the tier's model, effort and caps and the stored session id."
    - kind: "manual"
      check: "in a scratch office, run `dipo run --dry-run <ID>` for a Ready story"
      expect: "prints the branch and worktree path it would create and the full worker launch; `git branch -a` and `git worktree list` are unchanged and no run is started."
    - kind: "manual"
      check: "in a scratch office, right after `dipo run <ID>`, before the session does anything, check the branch and worktree"
      expect: "the branch from the field block exists, `git log -1 <branch>` shows the claim commit `<ID>: status In Progress`, and `git worktree list` shows `<root>/<ID>` locked."
    - kind: "manual"
      check: "in a scratch office, set a fixture story Ready through the Backlog CLI and run `dipo run`"
      expect: "prints the started story; `git worktree list` shows `<root>/<ID>` locked."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 After the claim, setup (DIPO-39) runs; a setup failure ends in DIPO-39's rollback with the `pickupCheckFailed` skip, and no worker starts.
- [x] #2 The launch checks of DIPO-43 run before the host starts; a refusal rolls back the claim like a setup failure, keeps the story Ready and leaves the DIPO-43 adapter hold in place.
- [x] #3 The engine renders the system file and task message (DIPO-47) and starts a worker host (DIPO-44) with the tier's model, effort and caps, an engine-made session id stored on the run, and the absolute `claude` path resolved at daemon start.
- [x] #4 Ingestion (DIPO-45) starts for the run when its host starts, and the engine emits `work.phase build`.
- [x] #5 The run's slot from setup is recorded on the run.
- [x] #6 The Claude CLI `WorkerAdapter` is built per run in `workers/claude-cli/adapter.ts` with `plan(spec)` closing over a `ClaudeLaunchContext` (DIPO-40's `plan(spec, ctx)`), so the engine calls the 0008 signature; a test under `packages/engine/test/run/` covers the binding.
- [x] #7 When `plan` refuses a path (DIPO-40: rule-special characters such as parentheses, a workdir at home or `/`), the run is not started and an `engine.notice` names the path and the character and suggests moving the checkout or the worktree root; a test covers it.
- [x] #8 The daemon passes its resolved absolute `backlog` path into `backlogFeature` (DIPO-28 runs `backlog` from PATH today), next to AC #3's resolved `claude` path; a test covers it.
- [x] #9 `dipo run --dry-run [<ID>...]` selects a story as `work.run` does and prints, without claiming, creating a branch or worktree, writing a run row or starting a worker: the branch and worktree path it would create, the full `claude` launch (absolute path, arguments, model, effort, caps, sandbox settings, environment variable names without values), the system file and the task message; a test shows that no fact, branch, worktree or run changed.
- [x] #10 Branch and worktree creation is tested apart from the worker launch: with the worker start stubbed, a run creates the branch named in the story field block, the locked worktree at `<root>/<ID>` and the claim commit, and stops before any worker starts; a manual test step checks them before a live session.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Split from DIPO-48 in the M0 review (DIPO-15). Before cutover: built by hand-run agents.

Follow-up from DIPO-39 (2026-10-13): the daemon builds StoryClaims without the SlotTable (packages/daemon/src/foreground.ts); pass slots: SlotTable.inState(stateDir) as StoryTeardown does, so a claim's setup takes and frees its slot in the real daemon.

Follow-up from DIPO-48 (2026-10-14): releasing a claim (teardown, rollback, work.stop or work.discard), or ending a run in any other way, must set runs.ended_at and runs.end_kind for its run. Retention removes runs and run_steps only once ended_at is set (packages/engine/src/retention/run.ts), and config_snapshots only once no kept run names them. Until then, activeRuns treats a story run whose claim is released as inactive, but its rows are kept forever.

Added 2026-10-14 by the maintainer: a dry-run preview of the worker call, so the instructions Claude gets can be checked without a live session, and branch and worktree creation tested on its own. The dry-run option on work.run is a contract addition and needs a 0005 amendment approved by the maintainer when this story is built.

Built 2026-10-14 (DIPO-74). work.run with a RunLauncher (packages/engine/src/run/launch.ts) passes ClaimRequest.setup: DIPO-39 setup, then the system file and task message (run/prompts.ts, context pack from the new worktree), the WorkerSpec from the tier with a session id derived from the agent id (UUID v4 shape), and the launch checks through the WorkerPort (workers/port.ts; Claude CLI in workers/claude-cli/adapter.ts). Any failure there fails setup, so claimStory rolls back (worktree removed, new branch deleted at its start, story Ready, pickupCheckFailed). A path the plan refuses also emits engine.notice run.planRefused naming the path and the character (PlanError now carries refused.path and refused.character). After the claim commit the host starts (run/hosts.ts systemHostStarter), OfficeIngest tracks it (first pass plus 1 s poll, advanced via the host socket when it answers), and work.phase build follows. A host that does not start releases the claim keeping the branch as released (StoryClaims.releaseUnstarted) and ends the run as start-failed. releaseClaim and the claim rollback now set runs.ended_at and end_kind. The session id and effort are stored on the run's agents row (no migration). A held adapter still refuses work.run without stories; a run that names its stories repeats the launch checks, which lift the hold (the DIPO-43 hold text asks for an explicit run). Dry run: read work.preview (contract minor 1, since: 1) and dipo run --dry-run; it skips fetch, index and profile refresh and evaluates the pickup gate with GateStore.checkGate (stores nothing). Daemon: one BacklogCli with the resolved absolute backlog for every feature (engineFeatures({ backlog })), StoryClaims gets the SlotTable, the run temp directory is <realpath tmp>/dipo-run-<run>. Deferred: worker exit handling (onEnded, onInitRejected) and run end on exit are DIPO-51; mcp.json and tool variables are not passed yet (toolVariables: []); the run temp directory is not removed at run end; canResume checks only the transcript (version and prompt hash at DIPO-51); prompt parts and context pack are not recorded. 0005 amendment for work.preview awaits the maintainer's approval.

Live test 2026-10-14 on dipsaus9/dipo-scratch-backlog (build d532010): dry run printed the launch and changed nothing; the stubbed CI test showed branch, locked worktree and claim commit; a live dipo run TASK-1 ran setup, the sandbox self-test and a haiku worker that implemented the story (2 tests pass), reported done with evidence, cost USD 0.005 in 8 turns, and committed nothing. The worker stays idle after its report until DIPO-51; the worker host outlives daemon stop (DIPO-57). Setup failed first because ~/.bun/bin/bun is a Safe-Chain wrapper that cannot write its temp file in the step sandbox; the daemon ran with ~/.bun/bin-originals first on PATH.
<!-- SECTION:NOTES:END -->
