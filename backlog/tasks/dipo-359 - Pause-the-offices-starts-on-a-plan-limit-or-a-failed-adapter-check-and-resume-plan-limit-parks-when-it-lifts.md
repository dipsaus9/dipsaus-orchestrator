---
id: DIPO-359
title: >-
  Pause starts on a plan limit or failed adapter check and resume plan-limit
  parks
status: Done
assignee: []
created_date: '2026-10-27 16:52'
updated_date: '2026-10-28 09:11'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:1'
milestone: m-1
dependencies:
  - DIPO-344
references:
  - packages/contract/src/
  - packages/engine/src/run/
  - packages/engine/src/workers/
  - packages/engine/src/views/
  - packages/cli/src/
  - packages/tui/src/
priority: high
type: feature
ordinal: 339000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a plan limit or a failed adapter check pauses the office's starts instead of holding runs, the desk shows it first, and the sessions the plan limit parked resume by themselves when the limit lifts.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. Split from DIPO-344 (its criteria 4 and 5), which built the one park and the eight reasons. Maintainer decisions of 2026-10-24 (audit questions 3 and 10; 0020). Starts paused is office state, not a park. Use the engine's clock port so tests run on a manual clock.

```dipo
branch: "DIPO-359/starts-paused-on-plan-limit"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine, manual clock) a plan limit pauses starts, parks the running session and resumes it when the reset time passes"
    - kind: "automated"
      check: "(engine) a failed adapter check pauses starts and a passing check lifts it"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A plan limit or a failed adapter check sets the office's starts paused with its reason and time, no new session starts until it lifts, and the desk shows it first
- [x] #2 A session that hits the plan limit parks worker-failed with the detail plan limit until the reset time, and dipo resumes exactly those parks when starts paused lifts
- [x] #3 The mechanisms this replaces (the office health paused state and any hold of runs on a plan limit) are removed
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A plan limit or a failed adapter check sets the office's starts paused (table starts_paused, migration 0059) with its reason, detail and time. Adapter holds are stored there too, so they survive a restart. While it holds, no session starts: work.run, the places, work.resume, the scan fallback, and the next session of a running run (crash retry, report feedback, handoff, after a restart) are all gated. The desk shows it first in the CLI and TUI. A session that meets the plan limit parks worker-failed with the detail plan limit until <time> and resume_on_lift set, and when the pause lifts, on the clock port, dipo resumes exactly those parks through the one resume path with no cap growth. The plan-limit hold, Health paused and limited, the plan-limit signal, wait facts, resumeWait, the model-family place pauses and plan_limit_warnings are removed. Runs a plan limit held before the upgrade park at load and resume on lift. Follow-up on adapter holds of unloaded offices moved to DIPO-355.
<!-- SECTION:FINAL_SUMMARY:END -->
