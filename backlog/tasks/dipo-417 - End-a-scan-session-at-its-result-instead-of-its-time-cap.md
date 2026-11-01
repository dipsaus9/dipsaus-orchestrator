---
id: DIPO-417
title: End a scan session at its result instead of its time cap
status: In Progress
assignee: []
created_date: '2026-11-01 18:00'
updated_date: '2026-11-01 18:11'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/run/session-run.ts
  - packages/engine/test/run/session-run.test.ts
priority: medium
type: bug
ordinal: 395000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo office infer` ends as soon as its session answers, and the answer becomes a proposal, instead of running into the five-minute cap and failing.

Gap G24, 2026-11-01, run run_01M6C3YF3GZYC9RWHR4H5WSNGJ on the scratch office (binary 25ea09e3, after DIPO-413): the session answered in 2.9 s with a StructuredOutput call holding a `test` proposal, and the CLI ended its turn with `result success`. The session was started with stream-json input, so Claude Code then waited for more input on stdin. packages/engine/src/run/session-run.ts never closes stdin after a turn, so at 300 s its time cap sent the stop; the stopped session answered `{"proposals":[]}` and `dipo office infer` failed with "dipo stopped it: its time cap of 5 minutes was reached". Developer and reviewer sessions close stdin after their turn (run/control-turns.ts, run/reviews.ts); the session runner does not.

Design: the session runner sends `closeStdin` once its session's turn event arrives, as the reviewer path does, so the CLI exits and the answer is read from that turn. The caps stay as a backstop. 0008, 0013.

```dipo
branch: "DIPO-417/scan-session-ends-at-result"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a scan session whose worker emits its turn with an answer gets its stdin closed at once and ends answered, without reaching its time cap"
    - kind: "manual"
      check: "(live) on the scratch office, run dipo office infer with the re-pinned binary"
      expect: "it ends within a minute with a proposal on the desk, not with a time cap"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 When a scan session's turn event arrives, the session runner sends the host `closeStdin` once, and the session ends answered with that turn's answer, shown by a test whose fake worker keeps stdin open until it is closed
- [ ] #2 A session that never sends a turn still ends at its time or budget cap as now, shown by the existing tests
- [ ] #3 The runner's file comment says the session ends at its first turn: dipo closes its stdin there, and the schema retry is the CLI's own, inside that turn
<!-- AC:END -->
