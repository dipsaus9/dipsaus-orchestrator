---
id: DIPO-249
title: Find and report what makes a dipo run start slowly before its claim
status: Done
assignee: []
created_date: '2026-10-20 18:35'
updated_date: '2026-10-23 10:35'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies:
  - DIPO-300
references:
  - packages/engine/src/run/work-run.ts
  - packages/engine/src/gate/store/feature.ts
  - packages/cli/src/run-command.ts
  - packages/engine/test/run/work-run.test.ts
priority: low
type: bug
ordinal: 249000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo run` either starts within seconds or says what it is waiting for, so a start that takes minutes is no longer silent.

Context: on 2026-10-20 `dipo run DIPO-136` took about 3.5 minutes before its claim (command at about 15:20:20, the keep-awake line "1 claimed story waiting to start" at 15:23:53) with no output; earlier and later starts took seconds. Meanwhile `backlog milestone list` calls were seen under the daemon, so the Ready gate's Backlog CLI reads or the office git queue are candidates; the daemon logged at info level, so nothing shows the step. work.run (packages/engine/src/run/work-run.ts) fetches, checks the office, reads the gate (packages/engine/src/gate/store/feature.ts) and claims; packages/cli/src/run-command.ts waits for the reply. The cause is not traced, so the first step is to measure.

```dipo
branch: "DIPO-249/slow-run-start"
unknowns:
  - q: "What took the 3.5 minutes before the DIPO-136 claim? Reproduce with debug logging (dipo daemon log-level debug) on the temp office while a poll and a reconcile run, time each step of work.run, and record the cause here before the criteria are final."
    status: "open"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) work-run.test.ts: each step of work.run before the claim logs its duration at debug, and a step over the slow threshold logs an info line naming it"
    - kind: "manual"
      check: "(live) start a Ready story on the temp office while a poll runs"
      expect: "the start takes seconds, or the CLI prints what it waits for"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Each step of work.run before the claim (fetch, office checks, gate read, claim) logs its duration at debug, and a step that takes more than 10 seconds logs one info line naming the step and the time it took
- [ ] #2 While a work.run waits more than 10 seconds before its claim, `dipo run` prints one line saying which step it waits for
- [ ] #3 Unit tests in packages/engine/test/run/work-run.test.ts cover the debug durations and the slow-step info line with a manual clock
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-23 (maintainer): closed without a code change. Since DIPO-240 (box only, the box kept from claim to merge) a run takes 31 s from dipo run to a ready box, down from 3.5 to 5.5 minutes; nothing slow is left to find before the claim.
<!-- SECTION:NOTES:END -->
