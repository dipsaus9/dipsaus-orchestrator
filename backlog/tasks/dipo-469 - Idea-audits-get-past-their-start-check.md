---
id: DIPO-469
title: Idea audits get past their start check
status: Refined
assignee: []
created_date: '2026-11-09 22:24'
updated_date: '2026-11-09 22:24'
labels:
  - 'tier:S'
milestone: m-3
dependencies: []
references:
  - packages/engine/src/workers/claude-cli/box-plan.ts
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/src/workers/claude-cli/tools.ts
  - packages/engine/src/workers/claude-cli/adapter.ts
  - packages/engine/test/workers/audit-tools.test.ts
  - packages/engine/test/workers/planning-tools.test.ts
  - packages/engine/test/workers/box-plan.test.ts
  - packages/engine/test/recordings/claude-cli
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0022-planning-sessions.md
priority: high
type: bug
ordinal: 442000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want each idea's audit session to get past its start check, so that the ideas dipo holds are audited and reach my desk as proposed user stories again.

M3 (maintainer's choice, 2026-11-09). The trigger: since DIPO-452 (c1e3809c) every idea audit is stopped at its start. The daemon log repeats all day on 2026-11-09: `WARN an audit left ideas held ideas=20 reason="the audit session failed: dipo stopped it: tools StructuredOutput are not an audit session's"`. More than 20 ideas are held and none reaches the maintainer (0022).

The cause: the box plan (packages/engine/src/workers/claude-cli/box-plan.ts, `--json-schema` for every kind but planning) passes the report schema to an audit, since the audit ends in one structured answer (0022). Claude Code then lists `StructuredOutput`, `REPORT_TOOL` in packages/engine/src/workers/claude-cli/interpret.ts, in `system/init`. The init check in interpret.ts runs `foreignTools(kind, msg.tools)` (packages/engine/src/workers/claude-cli/tools.ts) for planning and audit, and the audit maps to `PLANNING_TOOLS`, which lacks `StructuredOutput`, so every audit is rejected at init. A review also gets the schema but is not checked at init, so reviews pass. The audit init tests (packages/engine/test/workers/audit-tools.test.ts) feed a hand-made init with `PLANNING_TOOLS` only, never what Claude Code lists for a session with a schema, so no test caught it.

The fix, one mechanism (0001): the box plan owns whether a session reports through `--json-schema`, and the init check reads that fact instead of keeping its own idea of it. One function next to the box plan answers whether a kind's plan passes the report schema; the plan uses it to add `--json-schema`, and the adapter (packages/engine/src/workers/claude-cli/adapter.ts) puts its answer in the parse state, so the init check allows `REPORT_TOOL` exactly for a session whose plan passed the schema. The read-only tool sets in tools.ts stay as they are and keep deciding every other tool: `PLANNING_TOOLS` does not gain `StructuredOutput`, so `--tools` and `checkReadOnlyArgv` are unchanged. A planning session passes no schema, so `StructuredOutput` in its init is still rejected. This replaces nothing but the init check's implicit rule that no read-only session reports by schema.

No ADR changes: 0022 already says the audit ends in one answer the engine validates, and 0008 already names `--json-schema` in the session plan; the report tool is how that answer comes back, not a tool the audit works with.

Built by dipo where it can; a builder agent takes over if dipo gets stuck. A failed audit leaves its ideas held and never drops one (0022), so the held ideas are audited at the next trigger once the fix is pinned.

```dipo
branch: "DIPO-469/audit-start-check"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) packages/engine/test/workers/audit-tools.test.ts: an audit session whose plan passed --json-schema and whose system/init lists PLANNING_TOOLS plus StructuredOutput is not rejected at init and reads its one answer from the structured output"
    - kind: "automated"
      check: "(unit) packages/engine/test/workers/audit-tools.test.ts: the old barrier still rejects at init an audit that lists Bash, Write, Edit, Task, mcp__x__y or a lower-case bash next to PLANNING_TOOLS and StructuredOutput, one case each"
    - kind: "automated"
      check: "(unit) bypass forms, each rejected at init: StructuredOutput in a planning session's init (its plan passes no schema), the near-miss names structuredoutput, Structured_Output, StructuredOutputs and mcp__x__StructuredOutput in an audit's init, and StructuredOutput in an audit whose parse state says no schema was passed"
    - kind: "automated"
      check: "(unit) packages/engine/test/workers/box-plan.test.ts: the one function decides --json-schema for every kind (implement, review, audit pass it, planning does not), the adapter's parse state carries the same answer for each kind, and a planning plan with --json-schema added is refused by checkReadOnlyArgv"
    - kind: "automated"
      check: "(unit) fail closed on the real path: a recording of a real audit session's stream (packages/engine/test/recordings/claude-cli/) replayed through the real interpreter with the adapter's audit parse state passes init with StructuredOutput, and the same recording with Bash added to its init is rejected"
    - kind: "manual"
      check: "After the story merges and dipo is re-pinned, wait for the next audit trigger (or add one idea with dipo idea), then read the daemon log and dipo ideas, and open dipo desk"
      expect: "the log shows no 'tools StructuredOutput are not an audit session's' warning, the held ideas are passed or rejected with a reason in dipo ideas, and each passed idea is on the desk as a proposed user story"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An audit session whose plan passed --json-schema, and whose system/init lists the planning tools and StructuredOutput, passes its init check and its one answer is read from the structured output, with a test that uses the tool list Claude Code reports for a session with a schema
- [ ] #2 The init check allows REPORT_TOOL exactly for a session whose plan passed the report schema: one function next to the box plan decides both whether the plan adds --json-schema and what the adapter puts in the parse state, so the box plan owns it and the tool sets in tools.ts stay unchanged
- [ ] #3 The old barrier still rejects at init an audit that also lists Bash, Write, Edit, Task, an MCP tool such as mcp__x__y or a lower-case bash, with a test for each
- [ ] #4 Tests cover the bypass forms, each rejected: StructuredOutput in a planning session's init, whose plan passes no schema; near-miss names such as structuredoutput, Structured_Output, StructuredOutputs and mcp__x__StructuredOutput; StructuredOutput in an audit whose parse state says no schema was passed; and a planning plan with --json-schema added, refused by checkReadOnlyArgv
- [ ] #5 A fail-closed test on the real path replays a recorded real audit session stream through the real interpreter with the adapter's audit parse state: it passes init as recorded and is rejected when Bash is added to its init
<!-- AC:END -->
