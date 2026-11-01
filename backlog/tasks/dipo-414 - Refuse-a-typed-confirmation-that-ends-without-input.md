---
id: DIPO-414
title: Refuse a typed confirmation that ends without input
status: Done
assignee: []
created_date: '2026-11-01 15:39'
updated_date: '2026-11-01 16:33'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/cli/src/workspace.ts
  - packages/cli/src/
modified_files:
  - packages/cli/src/workspace-ask.test.ts
  - packages/cli/src/workspace.ts
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
- [x] #1 When input ends during `systemWorkspace().ask` (the real readline path, fed a closed input stream), ask returns no answer instead of throwing, and the command refuses with the same message as a wrong answer and exits non-zero without a stack trace, shown by a test
- [x] #2 A wrong answer and a right answer behave as now, shown by the existing tests
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-01 16:33 UTC
- Criteria met: 2 of 2 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 1, failed 0
- Budget used: 31,514 of 300,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 0
<!-- SECTION:FINAL_SUMMARY:END -->
