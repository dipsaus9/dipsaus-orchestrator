---
id: DIPO-466
title: Keep a worker's progress and say when it made none
status: Ready
assignee: []
created_date: '2026-11-08 12:17'
updated_date: '2026-11-08 12:41'
labels:
  - 'tier:M'
milestone: m-3
dependencies: []
references:
  - packages/engine/src/prompts/contract/implement-box.md
  - packages/engine/src/prompts/budget.ts
  - packages/engine/src/box/parts.ts
  - packages/engine/src/run/control-endings.ts
  - packages/engine/src/run/outcome-exits.ts
  - packages/engine/src/overview/desk.ts
priority: high
type: enhancement
ordinal: 439000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want each worker to hand its work as it meets each criterion, and dipo to say when a capped run handed nothing, so that a cap never throws away a run's work unseen.

M3 (maintainer's choice, 2026-11-08). The trigger: DIPO-458 (tier S, 9 criteria, 10 references) reached the turn cap after 91 turns with no part handed, and DIPO-454 (tier L) used 301 turns with no part. Their work stayed in the box, and the park said only budget-exceeded with the cap.

The box already commits and pushes each part the worker hands with dipo-part (0008, packages/engine/src/box/parts.ts), so work is lost because the worker hands none, not because dipo holds it back. The worker contract (packages/engine/src/prompts/contract/implement-box.md) asks for a part when a coherent piece of work is ready, and the wrap-up at about 80% of a cap (packages/engine/src/prompts/budget.ts) does not ask for one.

The fix: the contract asks for a part after each criterion the worker meets with its tests, and says a part is cheap (dipo checks and commits it, and the worker goes on); the wrap-up near a cap asks for a part of what works now. No new park reason: a turn, minute or token cap still parks budget-exceeded (packages/engine/src/run/control-endings.ts, packages/engine/src/run/outcome-exits.ts), and when the run's box handed no part, its park detail says no part handed next to the cap and what was used, and so does its desk line (packages/engine/src/overview/desk.ts). The park detail is text, as 0020 says, so no code decides from it. No ADR changes.

Built by dipo where it can (maintainer's choice, 2026-11-05); a builder agent takes over if dipo gets stuck.

```dipo
branch: "DIPO-466/keep-worker-progress"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the developer task message asks for a part after each criterion met with its tests and says a part is cheap, and the wrap-up message near a cap asks for a part"
    - kind: "automated"
      check: "(unit) regression: each handed part is committed and pushed before the next part is taken"
    - kind: "automated"
      check: "(unit) a turn, minute and token cap each park budget-exceeded with a detail that says no part handed, the cap and what was used, when the run's box handed no part, and the desk line shows it"
    - kind: "automated"
      check: "(unit) a cap after at least one part parks budget-exceeded without the no part handed text"
    - kind: "manual"
      check: "On the scratch repository with a Haiku office whose tier S turn cap is set to 5 in the office config, run a story that needs more than 5 turns"
      expect: "the desk shows the story Parked budget-exceeded with no part handed and the turn cap in its line, or without that text and with its parts on the PR when the worker handed one"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The worker contract asks the worker to hand a part after each criterion it meets with its tests and says that a part is cheap, since dipo checks and commits it, and the wrap-up near a cap asks for a part of what works
- [ ] #2 A regression test shows that each part the worker hands is committed and pushed before the next part is taken, so a cap loses at most the work since the last part
- [ ] #3 A run that reaches a turn, minute or token cap while its box has handed no part still parks budget-exceeded, and its park detail and desk line say no part handed next to the cap and what was used
- [ ] #4 A cap reached after at least one part parks budget-exceeded without the no part handed text
<!-- AC:END -->
