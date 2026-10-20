---
id: DIPO-229
title: Serialize a direct park resume with work.run's claim of the worker place
status: Refined
assignee: []
created_date: '2026-10-20 08:20'
updated_date: '2026-10-20 08:20'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies:
  - DIPO-208
references:
  - packages/engine/src/run/resumption.ts
  - packages/engine/src/run/places.ts
  - packages/engine/test/run/work-run.test.ts
  - packages/engine/test/run/park-resume.test.ts
  - packages/engine/test/run/resumption.test.ts
priority: high
type: bug
ordinal: 229000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a maintainer's park answer that arrives while work.run holds its claim open no longer starts a second session: the resume's worker place check and its reopen write run as one of the office's serialized steps, so the pickup or the resume takes the worker place and the other waits.

Context: DIPO-208 (PR #254, In Review) adds Places.serialized to packages/engine/src/run/places.ts and runs work.run's worker place check, claim and run record in one serialized step; its test in packages/engine/test/run/work-run.test.ts holds the claim open with claimGate and drains a queued resume inside that window. The direct path of a park resume, Resumption.resumePark and its steps in packages/engine/src/run/resumption.ts (reached from the park answer when it lifts the park), checks places.blocked and writes reopenParkedRun, the answer and the intent in one this.#s.write outside serialized, and starts the session at once when the place is free. An answer inside work.run's claim window sees the place free (the pickup's run is not recorded yet), so both start a session. The comment of Places.serialized says a step must never await drain or serialized of the same office, and startQueued runs inside a drain.

```dipo
branch: "DIPO-229/serialize-park-resume"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) with work.run's claim held open by claimGate, a park answer inside the window starts no session; the pickup holds the worker place and the resume waits in waitingStarts with the queued notice"
    - kind: "automated"
      check: "(unit) a park answer resumed first holds the worker place, and the pickup that follows is skipped for the worker place"
    - kind: "automated"
      check: "(unit) without places the park resume starts its session at once, and a queued resume started by a drain does not wait on serialized"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 In the direct park-resume path of packages/engine/src/run/resumption.ts, the places.blocked check, the reopen write with the answer and the intent, and the waitForPlace row are one step in places.serialized for the run's office; the drain fired for a queued resume stays a call that is not awaited, after that step
- [ ] #2 startQueued and recoverParkResumes never await Places.serialized from inside a drain, and without places the path runs as today
- [ ] #3 A test holds work.run's claim open with claimGate, as the DIPO-208 test does, answers a park inside the window and shows one session start: the pickup's story holds the worker place and the resume waits in waitingStarts with the queued notice
- [ ] #4 A second test resumes the park first and shows the pickup that follows skipped for the worker place
<!-- AC:END -->
