---
id: DIPO-61
title: Wait for plan-limit resets and resume
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-14 15:10'
labels:
  - 'tier:M'
  - after-cutover
milestone: m-0
dependencies:
  - DIPO-51
references:
  - packages/engine/src/run/plan-limit.ts
  - packages/engine/src/run/
  - packages/engine/test/run/
  - packages/engine/src/features.ts
  - packages/contract/
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/src/workers/types.ts
  - packages/engine/test/workers/
  - packages/daemon/src/runs.ts
  - packages/daemon/src/foreground.ts
  - packages/daemon/src/server.ts
  - packages/engine/src/workers/claude-cli/schema.ts
documentation:
  - docs/decisions/0006-daemon-and-ipc.md
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0017-testing-strategy-and-configuration.md
priority: medium
type: feature
ordinal: 61000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine schedules around plan limits: `allowed_warning` stops new runs on the scope, a rejected run resumes two minutes after `resetsAt` or after an hourly probe, session and weekly limits hold every office, model-family limits hold only that family, and `credits_required` holds the adapter until `work.resume`.

Context: until this story lands, a run held by a plan limit (DIPO-51) has no M0 way out except `work.stop`, which parks it `stopped`; this is an accepted operational gap (M0 review, DIPO-15). `work.resume` stays provisional in the contract until this story ships it for held runs and gives it a `since`. References: 0008 section 7 (plan-limit paragraph), open question 3; 0006 decision 7 (wait facts read back in recovery); 0017 scenarios `plan-limit-rejected`, `plan-limit-credits`, `api-retry-rate-limit`.

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

Built after cutover: dipo delivers this story itself (M0 review decision D14, DIPO-15).

```dipo
branch: "DIPO-61/wait-plan-limit-resets-resume"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) the three named scenarios on the manual clock, including a restart between reject and reset."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `allowed_warning` stops starting new runs on the affected scope until the reset.
- [x] #2 On the injected clock, a run with `resetsAt` resumes two minutes after it with "continue"; without it, a cheapest-resume probe runs once an hour.
- [x] #3 Scope `session`, `weekly` and `unknown` hold scheduling in every office; `model:<family>` holds only runs on that family.
- [x] #4 No fallback to another model and no maximum wait.
- [x] #5 `credits_required` writes scope `credits`, holds the run as paused and new runs on the adapter in every office, raises a notice, and is lifted by `work.resume` (implemented here for held runs only).
- [x] #6 Wait facts survive a daemon restart and are rescheduled in recovery.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S45 (DIPO-15). After cutover: built by dipo itself, not by a hand-run agent.

DIPO-61 implementation:
- Scope: the Claude adapter maps rateLimitType to the limit event's scope (five_hour session, seven_day weekly, seven_day_<family> model:<family>, else absent and the engine writes unknown, held as session). The live recordings show five_hour; the other names follow the same pattern and are unverified.
- run/plan-limit.ts: PlanLimits, the schedule. RunOutcomes tells it of every wait fact (waits dep) and every allowed_warning (onPlanWarning). A fact with resetsAt resumes two minutes after it, without one an hourly probe from since; both call RunOutcomes.resumeWait, which resumes the native session with 'continue' (a handoff when canResume refuses), resolves the stale pause intent and clears the plan-limit signal in the transaction that records the new agent (NextSessionRequest.clear; closes the DIPO-51 known gap). credits has no timer. Timers run on the injected clock; while the daemon is in safe or the held worker has not exited, the resume is tried again a minute later.
- Scheduling holds: held(adapter, model). session, weekly, unknown and warnings of those hold every office; model:<family> holds only models of that family; credits holds the adapter in every office. work.run refuses with run.refused check plan-limit (named stories too, since the launch checks do not lift a plan limit); a model-family hold skips the story as capacity (skip reasons are a closed enum). work.preview lists the refusal.
- allowed_warning holds its scope until resetsAt (an hour without one), in memory, with one engine.notice run.planLimitWarning on the software stream.
- Recovery: the load step plan-limits/recover reads every open wait fact back (openWait) and arms it; a reset passed while down resumes at once.
- work.resume ships with since 1 for held runs: resumes at once, lifts a credits adapter hold; story.notPausedOrParked for a story with no held run (parked stories too, not built yet, and park actions no longer offer work.resume); run.hostAlive while the held worker has not exited. Added to the daemon's SCHEDULING_COMMANDS (scheduling.off in safe).
- Tests: test/run/plan-limit.test.ts (manual clock: plan-limit-rejected, plan-limit-429 probes, model family, warnings, api_retry rate_limit, credits and work.resume, restart before and after the reset), work-run.test.ts (refusal and capacity skip), plan-limit.ci.test.ts (real resumer and git: held, restart, resume clears the signal).
<!-- SECTION:NOTES:END -->
