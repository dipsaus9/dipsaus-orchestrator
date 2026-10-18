---
id: DIPO-207
title: Start a resumed or re-attached session with the effort its run started with
status: Refined
assignee: []
created_date: '2026-10-18 14:31'
updated_date: '2026-10-18 14:32'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/daemon/src/runs.ts
  - packages/engine/src/run/resume.ts
  - packages/engine/src/run/reattach.ts
  - packages/engine/test/run/
  - packages/daemon/src/index.test.ts
priority: medium
type: bug
ordinal: 207000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a resumed, handed-off or re-attached worker session uses the model and effort its run started with, so editing an office tier never changes a parked or live story's session.

Context: review of DIPO-143 (PR #214). DIPO-143 made a run's caps come from its start snapshot (0020 section 5: a tier edit applies to new runs only). The worker spec of a later session still takes effort from the office tier in force: initialState in packages/daemon/src/runs.ts builds runWorkerSpec with `caps: tier` and the agents insert writes `tier.effort`, and the resumer builds its spec from the tier too (packages/engine/src/run/resume.ts). The run row stores the start model (runs.model, migration 0018) and every agent row stores its effort (agents.effort, migration 0004), so the start effort can be read from the run's first developer agent without a migration.

```dipo
branch: "DIPO-207/resume-with-start-effort"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a story started under tier M with effort medium, then resumed after the office's tier M changed to effort high and another model, starts its resumed session with the start model and effort medium"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A resumed or handed-off session's worker spec takes the model from the run row and the effort from the run's first developer agent, not from the office tier in force
- [ ] #2 A re-attached session's initial state in packages/daemon/src/runs.ts uses the same model and effort
- [ ] #3 A test edits the office tier between the start and the resume and expects the literal start model and effort in the resumed session's spec
<!-- AC:END -->
