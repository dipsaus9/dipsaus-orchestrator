---
id: DIPO-388
title: 'Report a resume that resolved a park as resumed, not as already running'
status: Refined
assignee: []
created_date: '2026-10-30 11:14'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/run/work-resume.ts
  - packages/cli/src/resume-command.ts
  - packages/engine/test/run/resumption.test.ts
priority: medium
type: bug
ordinal: 368000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo resume <story>` on a parked story prints that it resumed it, with the note and any budget top-up applied.

Gap G11, seen three times on 2026-10-30 (DIPO-376 twice, DIPO-377): `dipo resume DIPO-377 --note ...` resolved the park (parks.resolved_how = resume, resolved_note stored) and the run went on, and DIPO-376's --budget +50% raised max_turns to 90, yet the CLI printed "<story> already runs (run ...); it is In Progress, nothing to resume". The engine's work.resume returns changed false for a resume that did change state, and packages/cli/src/resume-command.ts:177 prints the no-change text for it. 0005, 0020.

```dipo
branch: "DIPO-388/resume-reports-resumed"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) work.resume on a parked story returns changed true, and false only when nothing was parked"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 work.resume returns changed true whenever it resolves a park (with or without a note or a budget top-up), and changed false only when the story was not parked
- [ ] #2 The CLI prints "resumed <story> ..." for a resolved park, and "already runs" only when nothing was parked; a test for each
- [ ] #3 A test reproduces the 2026-10-30 case: a story parked ambiguous-spec, resumed with a note, reports resumed, and the note is on the park
<!-- AC:END -->
