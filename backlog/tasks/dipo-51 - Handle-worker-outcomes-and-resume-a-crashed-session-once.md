---
id: DIPO-51
title: Handle worker outcomes and resume a crashed session once
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 14:37'
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
- [ ] #1 A missing or invalid report after a turn gets one feedback turn "report in the schema"; a second failure parks `ambiguous-spec`.
- [ ] #2 `terminal_reason: prompt_too_long` starts one new session with a handoff; a second hit parks `budget-exceeded`.
- [ ] #3 A crash with no recorded intent recovers usage, then resumes once with `--resume` and the full flag set when `canResume` holds (transcript present, same Claude Code version and L1+L2 hash, under 60% context, re-read cost at most three times a handoff), otherwise starts a handoff session; a second crash parks `worker-failed` with the last error.
- [ ] #4 A `system/init` whose `apiKeySource` is not `none`, or whose model is neither the planned model nor a recorded classifier switch, stops the worker and parks `worker-failed` with an `engine.notice`.
- [ ] #5 A classifier model switch is recorded on the run with an `engine.notice` and does not park.
- [ ] #6 A `startFailed` outcome from the CLI (startup failure, authentication, billing, account on hold) sets the adapter hold owned by DIPO-43, keeps the story Ready and emits an `engine.notice`.
- [ ] #7 Every outcome that ends a run goes through the `endRun` function of DIPO-49, so it writes its `run_outcomes` row.
- [ ] #8 A `rate_limit_event` with `status: rejected` or a 429 rate-limit turn closes stdin, writes a wait fact `{ scope, resetsAt?, since }` on the run, emits `work.observed plan-limit`, and never parks.
- [ ] #9 On resume the ingestor (DIPO-45) starts from the stored totals and baseline, and a counter reset in the CLI is told apart from restored spend, so no usage is counted twice or lost; a test with a resumed run covers it.
- [ ] #10 `endRun` calls `finalizeAgentUsage` (DIPO-45) for every agent of the run whose exit line was not ingested, so its usage reaches `usage_daily`; a test covers a run ending without an exit line.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S35 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
