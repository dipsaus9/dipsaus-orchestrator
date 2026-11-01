---
id: DIPO-414
title: Refuse a typed confirmation that ends without input
status: In Progress
assignee: []
created_date: '2026-11-01 15:39'
updated_date: '2026-11-01 16:27'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/cli/src/workspace.ts
  - packages/cli/src/
priority: low
type: bug
ordinal: 392000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a typed confirmation (as `dipo discard` asks) that gets no answer refuses as a wrong answer does, so the maintainer sees "nothing discarded", never a stack trace.

Found in the M1 hand-test wave of 2026-11-01 on the scratch office (binary 9c7d41238fbc). Input sent before the prompt reached readline as the end of input, and `dipo discard` printed Bun's raw `AbortError: Aborted with Ctrl+D` stack trace. Nothing was discarded. The prompt is `systemWorkspace().ask` in packages/cli/src/workspace.ts; the tests' fake workspace answers "" past its last answer, so they never reach this path. 0009.

```dipo
branch: "DIPO-414/confirm-on-eof"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(cli) a typed confirmation that reaches the end of input refuses with the usual message and no stack trace"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 When input ends during `systemWorkspace().ask` (the real readline path, fed a closed input stream), ask returns no answer instead of throwing, and the command refuses with the same message as a wrong answer and exits non-zero without a stack trace, shown by a test
- [ ] #2 A wrong answer and a right answer behave as now, shown by the existing tests
<!-- AC:END -->
