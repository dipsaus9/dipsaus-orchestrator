---
id: DIPO-51
title: Handle worker outcomes and resume a crashed session once
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-14 14:18'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-49
  - DIPO-50
references:
  - packages/engine/src/run/outcomes.ts
  - packages/engine/src/run/resume.ts
  - packages/engine/src/workers/claude-cli/resume-check.ts
  - packages/engine/src/run/
  - packages/engine/test/run/
  - packages/engine/src/ingest/
  - packages/engine/src/workers/
  - packages/engine/src/views/work.ts
  - packages/engine/src/prompts/
  - packages/engine/src/index.ts
  - packages/daemon/src/
  - packages/engine/test/workers/
  - packages/engine/test/recordings/claude-cli/
  - tools/recordings/derive.ts
  - docs/decisions/0007-state-database.md
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0014-worker-prompt-assembly.md
documentation:
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0014-worker-prompt-assembly.md
  - docs/decisions/0017-testing-strategy-and-configuration.md
priority: high
type: feature
ordinal: 51000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine acts on every Worker outcome of 0008 section 7 that M0 can meet: an invalid report gets one feedback turn, a too-long prompt gets one handoff session, a crash resumes the native session once when budget remains, a rejected init parks `worker-failed`, a start failure holds the adapter, and a plan-limit rejection holds the run with a notice.

Context: automatic waiting for plan-limit resets is DIPO-61. The adapter hold belongs to DIPO-43; this story sets it for `startFailed` outcomes and does not build a second one (M0 review, DIPO-15). References: 0008 section 7 (outcome table, `worker-failed`, `startFailed` hold, plan-limit hold), section 8 (native resume first, `canResume`, full flag set on resume, remaining budget), section 2 (`system/init` check of `apiKeySource` and model, recorded classifier switch); 0014 section 6 (resume thresholds, handoff); 0017 scenarios `terminated`, `crash-*`, `init-rejected`, `start-failed`, `report-invalid`, `prompt-too-long`, `plan-limit-rejected`.

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-51/handle-worker-outcomes-resume-crashed"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) one test per scenario named in Context, asserting the outcome, park reason or hold, and notices."
    - kind: "automated"
      check: "(unit) `canResume` threshold cases."
    - kind: "automated"
      check: "(engine) `resume` recording pair; resumed totals are not double counted."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A missing or invalid report after a turn gets one feedback turn "report in the schema"; a second failure parks `ambiguous-spec`.
- [x] #2 `terminal_reason: prompt_too_long` starts one new session with a handoff; a second hit parks `budget-exceeded`.
- [x] #3 A crash with no recorded intent recovers usage, then resumes once with `--resume` and the full flag set when `canResume` holds (transcript present, same Claude Code version and L1+L2 hash, under 60% context, re-read cost at most three times a handoff), otherwise starts a handoff session; a second crash parks `worker-failed` with the last error.
- [x] #4 A `system/init` whose `apiKeySource` is not `none`, or whose model is neither the planned model nor a recorded classifier switch, stops the worker and parks `worker-failed` with an `engine.notice`.
- [x] #5 A classifier model switch is recorded on the run with an `engine.notice` and does not park.
- [x] #6 A `startFailed` outcome from the CLI (startup failure, authentication, billing, account on hold) sets the adapter hold owned by DIPO-43, keeps the story Ready and emits an `engine.notice`.
- [x] #7 Every outcome that ends a run goes through the `endRun` function of DIPO-49, so it writes its `run_outcomes` row.
- [x] #8 A `rate_limit_event` with `status: rejected` or a 429 rate-limit turn closes stdin, writes a wait fact `{ scope, resetsAt?, since }` on the run, emits `work.observed plan-limit`, and never parks.
- [x] #9 On resume the ingestor (DIPO-45) starts from the stored totals and baseline, and a counter reset in the CLI is told apart from restored spend, so no usage is counted twice or lost; a test with a resumed run covers it.
- [x] #10 `endRun` calls `finalizeAgentUsage` (DIPO-45) for every agent of the run whose exit line was not ingested, so its usage reaches `usage_daily`; a test covers a run ending without an exit line.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S35 (DIPO-15). Before cutover: built by hand-run agents.

Follow-up from DIPO-74 (2026-10-14): derive the end of a run from runs.ended_at and runs.end_kind, not from a closing work.* event. A worker host that does not start ends its run as end_kind start-failed (the claim is released, the branch kept as released) and emits only an engine.notice run.startFailed, no closing work.* event; teardown and claim rollbacks also set ended_at and end_kind (their release reason).

Implementation (DIPO-51, 2026-10-14):
- run/outcomes.ts RunOutcomes decides turn problems, rejected inits, plan limits, classifier switches and every worker exit; run control is its RunEnder (begin, act, park). Each op is a run_intents row first, tagged in its detail: steer report-feedback, reassign new-session:context-full and new-session:error, pause plan-limit {scope, resetsAt?, since}, stop init-rejected and start-failed. Counters come from facts (run_intents, agents.end_reason), each once per run and independent (Q5).
- Exit order: the turns before the exit are decided while the run is still tracked; then a run that ended stops; an unresolved explaining intent decides by its tag; an unanswered report feedback resumes with it as first message; otherwise WorkerPort.result.
- run/resume.ts RunResumer starts the run's next session as a new agent: --resume with a short delta (prompts/feedback/resume.md) when canResume holds, else a handoff (renderRunPrompts with handoff). Launch checks run again; CLI caps get the remaining budget; worker_hosts.processed_offset is set to the event file size before the new host started; the parser starts from the previous agent's stored state (WorkerPort.initialState(spec, previous)). Emits work.assigned and run.resumed or run.handoff.
- workers/claude-cli/resume-check.ts: transcript under <home>/.claude/projects, version, system hash (agents.system_hash, now written at launch), 60% context share, re-read cost x0.1 warm or x2 cold against 3 x handoff tokens x2 (0014 amendment constants, RESUME_POLICY).
- interpret.ts: turn events carry an adapter-neutral problem; a 429 turn also emits limit rejected; classifier switches are added to acceptedModels from main-agent messages and results; restoredFloor tells restored spend from a counter reset per field.
- ingest: onEnded carries the exit record and parser state; the exit code is kept on worker_hosts; endRun finalizes agents whose exit was not ingested (finalizeRunAgents) and later changes to final rows feed usage_daily as a change only (0007 amendment).
- views/work.ts: an exited worker of a run held for a plan limit is limited, not lost. openWait(office, run) for DIPO-61.
- Q6: RunOutcomes.feature adds the office load step run-outcomes/redispatch: once loaded, active story runs whose newest agent ended exited, with no open wait, are decided again. DIPO-56 (merged first) releases orphan claims only for runs with no worker_hosts row, so held and crash-to-resume runs are safe; no change needed there.
- Recordings derived: plan-limit-rejected, plan-limit-429, model-switch.

Deviations from the plan:
- WorkerAdapter.canResume takes a third argument ResumeFacts (now, version, system hash, handoff tokens, share, factor). WorkerPort gained result and sessionFacts, so the engine never reads the Claude parse state. WorkerResult gained detail for startFailed.
- A startFailed turn closes the worker with a stop start-failed intent at the turn; the hold and release happen at the exit.
- The re-read idle time uses ingest_cursors.updated_at (engine clock) as the last request time; host line t is not on the engine clock.
- A worker exit with a done report on a still-active run is left to verify and commit (DIPO-49).

Known gaps for follow-ups: DIPO-61 clears the plan-limit signal when it resumes; a daemon stop between a crash decision (end_reason crashed) and the next agent row leaves the run active without redispatch.
<!-- SECTION:NOTES:END -->
