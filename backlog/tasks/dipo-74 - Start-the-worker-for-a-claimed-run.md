---
id: DIPO-74
title: Start the worker for a claimed run
status: To Do
assignee: []
created_date: '2026-10-12 09:22'
updated_date: '2026-10-12 21:44'
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
      check: "in a scratch office, set a fixture story Ready through the Backlog CLI and run `dipo run`"
      expect: "prints the started story; `git worktree list` shows `<root>/<ID>` locked."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 After the claim, setup (DIPO-39) runs; a setup failure ends in DIPO-39's rollback with the `pickupCheckFailed` skip, and no worker starts.
- [ ] #2 The launch checks of DIPO-43 run before the host starts; a refusal rolls back the claim like a setup failure, keeps the story Ready and leaves the DIPO-43 adapter hold in place.
- [ ] #3 The engine renders the system file and task message (DIPO-47) and starts a worker host (DIPO-44) with the tier's model, effort and caps, an engine-made session id stored on the run, and the absolute `claude` path resolved at daemon start.
- [ ] #4 Ingestion (DIPO-45) starts for the run when its host starts, and the engine emits `work.phase build`.
- [ ] #5 The run's slot from setup is recorded on the run.
- [ ] #6 The Claude CLI `WorkerAdapter` is built per run in `workers/claude-cli/adapter.ts` with `plan(spec)` closing over a `ClaudeLaunchContext` (DIPO-40's `plan(spec, ctx)`), so the engine calls the 0008 signature; a test under `packages/engine/test/run/` covers the binding.
- [ ] #7 When `plan` refuses a path (DIPO-40: rule-special characters such as parentheses, a workdir at home or `/`), the run is not started and an `engine.notice` names the path and the character and suggests moving the checkout or the worktree root; a test covers it.
- [ ] #8 The daemon passes its resolved absolute `backlog` path into `backlogFeature` (DIPO-28 runs `backlog` from PATH today) and `office.reloadConfig` reaches `OfficeGit.configure()` (DIPO-31 reads git settings only at load); tests cover both.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Split from DIPO-48 in the M0 review (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
