---
id: DIPO-388
title: 'Report a resume that resolved a park as resumed, not as already running'
status: In Review
assignee: []
created_date: '2026-10-30 11:14'
updated_date: '2026-10-30 20:26'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/run/park-resume.ts
  - packages/engine/src/run/work-resume.ts
  - packages/engine/src/commands/registry.ts
  - packages/cli/src/resume-command.ts
  - packages/engine/test/run/
priority: medium
type: bug
ordinal: 368000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo resume <story>` on a parked story prints that it resumed it, with the note and any budget top-up applied.

Gap G11, seen three times on 2026-10-30 (DIPO-376 twice, DIPO-377): `dipo resume DIPO-377 --note ...` resolved the park (parks.resolved_how = resume, resolved_note stored) and the run went on, and DIPO-376's --budget +50% raised max_turns to 90, yet the CLI printed "<story> already runs (run ...); it is In Progress, nothing to resume". Cause (review of PR #462): the park paths of a resume, `#resumeHold` and `parks.resume` (run/park-resume.ts about lines 652 and 763), set no `changed`, so `CommandOutcome.changed` falls back to "any entry emitted" (commands/registry.ts:60), and a resume that emits no entry reports false. work-resume.ts sets changed false only for a story that is not parked, which is right. The CLI line (cli/src/resume-command.ts:176-181) is right too. 0005, 0020.

```dipo
branch: "DIPO-388/resume-reports-resumed"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a resume that resolves a park reports changed true; only a story that was not parked, or a replayed request, reports false"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A resume that resolves a park, through #resumeHold or parks.resume, sets changed true explicitly (with or without a note or a budget top-up); changed false stays for a story that was not parked and for a replayed request
- [x] #2 The CLI prints "resumed <story> ..." for a resolved park and "already runs" only when nothing was parked; a test for each
- [x] #3 A test reproduces the 2026-10-30 case: a story parked ambiguous-spec, resumed with a note, reports resumed, and the note is on the park
<!-- AC:END -->
