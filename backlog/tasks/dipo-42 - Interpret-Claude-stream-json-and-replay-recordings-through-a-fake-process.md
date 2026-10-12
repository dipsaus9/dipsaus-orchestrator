---
id: DIPO-42
title: Interpret Claude stream-json and replay recordings through a fake process
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 13:28'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-41
references:
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/src/workers/claude-cli/result.ts
  - packages/engine/src/workers/claude-cli/schema.ts
  - packages/engine/src/workers/scripted.ts
  - packages/testkit/src/fake-process.ts
  - packages/engine/test/workers/
  - packages/testkit/src/index.ts
  - packages/testkit/src/fake-process.test.ts
  - packages/engine/src/index.ts
documentation:
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0017-testing-strategy-and-configuration.md
priority: high
type: feature
ordinal: 42000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the Claude CLI adapter's pure `interpret` and `result` turn stream-json lines and hook lines into Worker events and a Worker result, and engine tests replay recordings through an injected fake process on the manual clock, with a `ScriptedWorker` for tests that need no Claude detail.

Context: one parser serves live runs and replay after a daemon restart. References: 0008 sections 1 (interpret, result), 3 (event mapping), 4 (usage dedup by message id, placeholder output tokens, turn-end replacement, resume delta), 7 (outcome table); 0017 section 2 (fake replaces the subprocess, replay on clock deltas, SIGINT and SIGTERM handling, stdin recording, `ScriptedWorker` contract test), strict-on-used-fields schema.

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-42/interpret-claude-stream-json-replay"
unknowns:
  - q: "Which channel holds the report per turn in streaming input? Open until the DIPO-41 live check answers it."
    status: "resolved"
    answer: "DIPO-41 live check (2026-10-12, Claude Code 2.1.296): `--json-schema` holds per turn in streaming input; every completed turn's result carries `structured_output`, while aborted (`aborted_streaming`) and `error_max_turns` turns carry none. The adapter reads the report from `structured_output` only; the 0008 fallback is not needed."
test_plan:
  entries:
    - kind: "automated"
      check: "(contract) every committed recording parses with the adapter schema."
    - kind: "automated"
      check: "(unit) per recording, the expected outcome and proposed park reason from `meta.json`."
    - kind: "automated"
      check: "(unit) usage arithmetic reads expected numbers from the recordings."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `interpret(line, state)` is pure and maps each row of the 0008 section 3 table to its Worker event.
- [x] #2 Usage is counted once per `message.id`; subagent usage uses `parent_tool_use_id`; at turn end the result's cumulative `modelUsage` replaces live numbers; on resume only the change since the last stored totals is added.
- [x] #3 A crash result with zeroed totals keeps usage recovered from earlier assistant messages.
- [x] #4 A partial last line is held until complete; an unknown message type is logged once per run and ignored.
- [x] #5 `result(state, exit)` returns the outcome of the 0008 section 7 table when no intent is recorded, with a proposed park reason.
- [x] #6 The report is read from the channel recorded in DIPO-41 (`structured_output`, or the 0008 fallback), validated against the report schema.
- [x] #7 `FakeProcess` implements the contract `ChildProcess` type and replays a recording via an injected `Spawn` (DIPO-18), advances the manual clock by recorded `t` deltas, jumps to the post-interrupt tail on SIGINT, exits 143 with no result on SIGTERM, and records stdin writes.
- [x] #8 `ScriptedWorker` emits Worker events from a list, and a contract test rejects any script event the adapter schema could not produce.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S26 (DIPO-15). Before cutover: built by hand-run agents.

M0 review (DIPO-15): the open unknown is resolved through the Backlog CLI as soon as DIPO-41 lands, with the channel its implementation notes record; until then this story cannot pass the Ready gate (R15).

Added references: packages/testkit/src/fake-process.test.ts (testkit tests sit next to their source; unit tests of FakeProcess on synthetic lines) and packages/engine/src/index.ts (exports the parser, result, event schema and ScriptedWorker for later stories).

Implementation: `workers/claude-cli/schema.ts` (zod per used message, strict on used fields, tolerant of the rest; `ClaudeWorkerEventSchema`, the exact events the adapter emits), `interpret.ts` (pure; state is plain JSON), `result.ts`, `workers/scripted.ts`; `testkit/src/fake-process.ts` (`FakeProcess`, `fakeSpawn`, `readRecording`). Tests in `packages/engine/test/workers/`: `recordings.test.ts` replays all 23 recordings through the fake spawn (contract parse, outcome and park per recording, usage arithmetic), `interpret.test.ts` (0008 section 3 rows), `replay.test.ts` (SIGINT tail, SIGTERM 143, stdin, stall timer), `scripted.test.ts` with the script registry `scripts.ts`.

Decisions taken inside the ADRs:
- Report channel: `structured_output` only (DIPO-41 AC #9); invalid or missing gives `report: null` with the reason.
- Usage: live numbers are input, cache creation and cache read of deduplicated assistant messages (output stays 0 live). At a turn end the run adds the change of `modelUsage` since the last CLI totals (`baseline`); if any field went down the count restarted and all of it is new. A result with empty or all-zero `modelUsage` (crash, aborted turn) keeps the live numbers: recording `pause-now` shows the CLI's next totals leave the aborted turn's spend out. `initialState({ totals, baseline })` carries stored totals into a resumed run.
- `result` order: initRejected, startFailed (no park), plan-limit (no park), capped (sticky once a turn ends `error_max_turns`), signal or exit 143, partial line, no result, then the last turn. 0008 section 7 rows marked "none" need some `WorkerOutcome`: `prompt_too_long` gives `capped` with park `budget-exceeded` (resumable false), `error_max_structured_output_retries` and a missing or invalid report give `blocked` with `report: null` and park `ambiguous-spec`; the engine does the handoff or feedback turn first. A blocked report with `needsPermission` wins over its `question`.
- `meta.json` holds the expected outcome as prose only, so `recordings.test.ts` keeps a table per scenario and checks it against every "outcome X" and "park(s) X" that `meta.expected` names (budget-engine-cap's park is the engine's cap). Changing tools/recordings to add structured fields was out of scope.
- Unknown types are recorded in `state.unknownTypes`; `interpretLogged` logs each once per run. The subtypes DIPO-41 redacted whole (`background_tasks_changed`, `thinking_tokens`, `task_updated`) are known and ignored.
- Agent tool is `Agent` on 2.1.296 (`Task` kept too); `StructuredOutput` tool use is not activity.

Open for later stories: an init rejection lives only in the parse state (no Worker event carries `apiKeySource`), so the engine stopping the worker at once needs a way to read it (DIPO-44/45). `PostModelSwitch` and `PostCompact` hook payloads are not mapped (no recording shows their fields); `compact_boundary` and init or `modelUsage` model changes are.
<!-- SECTION:NOTES:END -->
