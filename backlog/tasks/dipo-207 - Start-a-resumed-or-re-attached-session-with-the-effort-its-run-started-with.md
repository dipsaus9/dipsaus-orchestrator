---
id: DIPO-207
title: Start a resumed or re-attached session with the effort its run started with
status: In Progress
assignee: []
created_date: '2026-10-18 14:31'
updated_date: '2026-10-20 07:32'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/daemon/src/runs.ts
  - packages/engine/src/run/resume.ts
  - packages/engine/src/run/reattach.ts
  - packages/engine/src/run/index.ts
  - packages/engine/test/run/
  - packages/daemon/test/unit/runs.test.ts
priority: medium
type: bug
ordinal: 207000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a resumed, handed-off or re-attached worker session uses the model and effort its run started with, so editing an office tier never changes a parked or live story's session.

Context: review of DIPO-143 (PR #214). DIPO-143 made a run's caps come from its start snapshot (0020 section 5: a tier edit applies to new runs only). A later session still takes its model and effort from the office tier in force. The resumer (packages/engine/src/run/resume.ts) builds its worker spec with `caps: tier`, and its agents insert (around lines 419 to 427) writes `tier.model` and `tier.effort`. initialState in packages/daemon/src/runs.ts builds runWorkerSpec with `caps: tier` too, so a re-attached session's initial state uses the tier's model (spec.model) and effort.

The run row stores the start model (runs.model, migration 0018, not null) and every agent row stores its effort (agents.effort, migration 0004), so the start effort can be read from the run's first developer agent without a migration. agents.effort is nullable: work.run writes null for a run claimed without a launcher. For a null effort the session falls back to the effort of the run's tier in force, which is what every session uses today (recommended and chosen here; the other choice, passing no effort so the CLI default applies, would change sessions that work now).

The daemon imports engine helpers by name through packages/engine/src/run/index.ts, so a new reader of the start model and effort is exported there. The daemon's runs.ts tests live in packages/daemon/test/unit/runs.test.ts.

```dipo
branch: "DIPO-207/resume-with-start-effort"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a story started under tier M with effort medium, then resumed after the office's tier M changed to effort high and another model, starts its resumed session with the start model and effort medium"
    - kind: "automated"
      check: "(daemon) a session re-attached after the office's tier M changed to effort high and another model gets an initial state built with the start model and effort medium"
    - kind: "automated"
      check: "(engine) a resumed session whose first developer agent has no effort recorded uses the effort of the run's tier in force"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A resumed or handed-off session's worker spec and its agents row take the model from the run row and the effort from the run's first developer agent, not from the office tier in force
- [ ] #2 A re-attached session's initial state in packages/daemon/src/runs.ts uses the same model and effort
- [ ] #3 When the run's first developer agent has a null effort, the session uses the effort of the run's tier in force, with a test in packages/engine/test/run/
- [ ] #4 Tests edit the office tier between the start and the resume, and between the start and a re-attach, and expect the literal start model and effort in the resumed session's spec (packages/engine/test/run/) and in the re-attached session's initial state (packages/daemon/test/unit/runs.test.ts)
<!-- AC:END -->
