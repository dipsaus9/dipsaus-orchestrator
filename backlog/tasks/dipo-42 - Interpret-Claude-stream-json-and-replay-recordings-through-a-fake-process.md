---
id: DIPO-42
title: Interpret Claude stream-json and replay recordings through a fake process
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 09:52'
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
    status: "open"
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
- [ ] #1 `interpret(line, state)` is pure and maps each row of the 0008 section 3 table to its Worker event.
- [ ] #2 Usage is counted once per `message.id`; subagent usage uses `parent_tool_use_id`; at turn end the result's cumulative `modelUsage` replaces live numbers; on resume only the change since the last stored totals is added.
- [ ] #3 A crash result with zeroed totals keeps usage recovered from earlier assistant messages.
- [ ] #4 A partial last line is held until complete; an unknown message type is logged once per run and ignored.
- [ ] #5 `result(state, exit)` returns the outcome of the 0008 section 7 table when no intent is recorded, with a proposed park reason.
- [ ] #6 The report is read from the channel recorded in DIPO-41 (`structured_output`, or the 0008 fallback), validated against the report schema.
- [ ] #7 `FakeProcess` implements the contract `ChildProcess` type and replays a recording via an injected `Spawn` (DIPO-18), advances the manual clock by recorded `t` deltas, jumps to the post-interrupt tail on SIGINT, exits 143 with no result on SIGTERM, and records stdin writes.
- [ ] #8 `ScriptedWorker` emits Worker events from a list, and a contract test rejects any script event the adapter schema could not produce.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S26 (DIPO-15). Before cutover: built by hand-run agents.

M0 review (DIPO-15): the open unknown is resolved through the Backlog CLI as soon as DIPO-41 lands, with the channel its implementation notes record; until then this story cannot pass the Ready gate (R15).
<!-- SECTION:NOTES:END -->
