---
id: DIPO-397
title: Emit a closing event when a run ends
status: Parked
assignee: []
created_date: '2026-10-30 16:01'
updated_date: '2026-10-30 20:48'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-320
references:
  - packages/engine/src/run/
  - packages/engine/src/scan/
  - packages/engine/src/worktree/
  - packages/engine/src/changelog/
  - packages/cli/src/watch-command.ts
priority: medium
type: bug
ordinal: 375000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: every run end (done, parked, dropped) emits an event on the office stream, so a client that follows the stream sees the end without polling.

Gap G13, found by the review of PR #468 (DIPO-320): a run can end without a closing event on the office stream, so `dipo watch` keeps a 15 s idle story.detail check to notice it (cli/src/watch-command.ts). The run endings are decided in one place since DIPO-373 (done, parked or dropped). Once every end emits an event, the idle check goes. 0005, 0020.

```dipo
branch: "DIPO-397/run-end-event"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) every run end path emits one closing event on the office stream"
park:
  reason: "ambiguous-spec"
  from: "In Progress"
  note: "May DIPO-397 add a new office-stream event `run.ended` (run id, kind, ending, endedAt, and the story's key and story id when the run has one), written by `endRun` in packages/engine/src/run/records.ts for every run end, and list it in the event catalog of docs/decisions/0005-command-and-event-model.md? That event is what lets scan session runs and runs with no agent reach the stream, and it is what would let watch drop its idle check."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The two run-end paths with no event, run/session-run.ts #end (scan session runs, bare endRun) and scan/fallback.ts endLostScanSessions (dropped at office load, bare endRun), write a change-log entry that reaches the office stream, like endRunMarked does; a test for each
- [ ] #2 Every endRunMarked path (park, review done, reconcile, control reconcile, and the claim release and record paths in worktree/claim.ts and worktree/records.ts) is shown by a test to reach the office stream as an event dipo watch can read as a run end, and the PR says what if anything was still missing there
- [ ] #3 dipo watch drops its idle check (#armIdle and the idle #recheck) and still prints every run end, with a test that a run ending at recovery and a scan session end are printed
- [ ] #4 No event is emitted twice for one end
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parked 2026-10-30 20:48 UTC: ambiguous-spec
- Detail: May DIPO-397 add a new office-stream event `run.ended` (run id, kind, ending, endedAt, and the story's key and story id when the run has one), written by `endRun` in packages/engine/src/run/records.t…
- Run: run_01M6792FJEXJMN6E62KBT99PSA
- Criteria met: 0 of 4 (as the worker reported them)
- Loops: 0 of 3; CI attempts: 0 of 2
- Review rounds: 0, failed 0 of 3
- Budget used: 56,321 of 300,000 tokens; 14 of 90 turns; 1 of 45 minutes
- Last good commit: 1aee7583f3f7481ee179fe48093eb2e7ff37a9ed
<!-- SECTION:NOTES:END -->
