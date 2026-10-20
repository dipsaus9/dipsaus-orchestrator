---
id: DIPO-163
title: Steer and pause a running worker
status: Done
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-20 08:43'
labels:
  - 'tier:M'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-138
  - DIPO-142
  - DIPO-145
references:
  - packages/contract/src/office.ts
  - packages/contract/schema/
  - packages/engine/src/run/
  - packages/engine/src/prompts/feedback/
  - packages/cli/src/
  - packages/engine/test/run/
  - packages/contract/src/errors.ts
  - packages/contract/src/work.test.ts
  - packages/contract/src/version.ts
  - packages/engine/src/views/work.ts
  - packages/engine/test/views/
priority: high
type: feature
ordinal: 152000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo steer and dipo pause reach the worker as ADR 0008 section 6 says, a steer to a paused or parked story is sent on resume, a steer to a reviewer is refused, and paused time is left out of the minute cap.

Context: implements ADR 0020 section 9 (steer and pause) on the mechanics of 0008 section 6 and the waiting command path of the 0005 note of 2026-10-17. work.steer and work.pause are provisional and unregistered today (0020 fact 7); work.reassign stays provisional.

```dipo
branch: "DIPO-163/steer-and-pause-workers"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a pause that arrives during an engine verify takes effect before the next worker turn"
    - kind: "automated"
      check: "(unit) a steer to a follow-only host answers story.notSteerable"
    - kind: "automated"
      check: "(unit) the work view of a paused run shows health paused, and dipo resume of a paused story whose worker place is taken is queued"
    - kind: "automated"
      check: "(unit) work.steer and work.pause are registered with their since, and packages/contract/src/work.test.ts no longer lists them as provisional"
    - kind: "automated"
      check: "(unit) a steer to a running worker is sent next turn wrapped in the steer template"
    - kind: "automated"
      check: "(unit) a steer to a parked story is stored once and sent on resume"
    - kind: "automated"
      check: "(unit) a steer to a reviewer session answers story.notSteerable"
    - kind: "automated"
      check: "(unit) a pause keeps the claim and place, exits after 10 minutes, and the paused time is out of the minute cap"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 work.steer (dipo steer <id> <text>) is stored first as a steer intent and sent as one next-priority user message wrapped in feedback/steer.md, and the reply says delivered next-turn
- [x] #2 A steer to a paused or parked story is stored once, keyed by its request, and sent with the first message on resume, and the reply says on-resume
- [x] #3 A steer to a story whose live session is its reviewer, or to a follow-only host, answers story.notSteerable
- [x] #4 work.pause (dipo pause <id>) stores a pause intent and sends a now-priority message; the run stays In Progress with health paused (viewOf in packages/engine/src/views/work.ts passes paused to deriveHealth) and keeps its claim, slot and session place; after 10 minutes stdin closes and the process exits, and dipo resume <id> continues it with --resume when allowed, and is queued when the worker place is taken (0020 section 9)
- [x] #5 Paused time is left out of the minute cap, and a pause that arrives during an engine verify takes effect before the next worker turn
- [x] #6 work.steer and work.pause are registered with their since on the waiting command path
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M5C5J9PF4Q449H4JCBV9V6ST (Sonnet, 85 turns, about $3.09, 17 min) reported done, In Review, with no denied call and no write outside the References; the first launch was refused by a flaky self-test (gap DIPO-230), the retry passed. work.steer sends a maintainer message to a running worker as a next-priority turn, or stores it once per request for a paused, parked or between-session run and sends it with the next session's first message; it answers story.notSteerable for a reviewer session or a follow-only host. work.pause stops the worker before its next turn (also during an engine verify, holding verify feedback), keeps the claim and the place, shows health paused, closes the worker's stdin after 10 minutes, and paused time does not count toward the minute cap; work.resume continues a live worker or starts a resume session, queued when the worker place is taken. workSteer and workPause are since 1. Fixed on top after review: a held steer or feedback item never goes into a reviewer session's first message (0002); it waits for the next worker session (test shown failing without the fix); the 10-minute test pins the story's value. Advisories, to the gap list: story.notSteerable sits in a separate STEER_ERROR_CODES list rather than OFFICE_ERROR_CODES (index.test.ts was outside scope); a queued resume resolves the pause when queued, so waiting for the place counts toward the minute cap; the pause message names `dipo resume`, which comes with DIPO-155; the reviewer-skip test reaches the reviewer place through runs.role rather than a review phase step. Verify outside the sandbox: 3929 tests, 0 fail; DIPO_TEST_CI=1 run, views, contract, cli and daemon tests pass.
<!-- SECTION:NOTES:END -->
