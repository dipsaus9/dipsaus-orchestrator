---
id: DIPO-234
title: >-
  List story.notSteerable with the office codes and test the reviewer skip by
  phase
status: Ready
assignee: []
created_date: '2026-10-20 10:40'
updated_date: '2026-10-20 10:44'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/contract/src/errors.ts
  - packages/contract/src/index.test.ts
  - packages/engine/src/run/resume-paused.ts
  - packages/engine/test/run/intervene.test.ts
priority: medium
type: chore
ordinal: 234000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: story.notSteerable is one of OFFICE_ERROR_CODES, a test pins that the wait of a queued pause resume for the worker place stays out of the minute cap, and the held-steer skip for a reviewer session is tested through a real review phase step, with a fix-round case that delivers the steer.

Context: advisories of the DIPO-163 review (PR #257). (1) packages/contract/src/errors.ts keeps story.notSteerable in its own STEER_ERROR_CODES list and SteerErrorCode type beside OFFICE_ERROR_CODES, because packages/contract/src/index.test.ts, which pins OFFICE_ERROR_CODES ("exports the office-level codes of minor 1") and spreads it in the retryable test, was outside DIPO-163's scope. Nothing imports STEER_ERROR_CODES. (2) The review said that a queued resume resolves the pause when it is queued, so the wait for the worker place would count toward the minute cap. On main that is not so: resumePaused in packages/engine/src/run/resume-paused.ts resolves the pause resume-queued and calls waitForPlace at the same instant; when the place frees, Places.drain calls claimPlace (packages/engine/src/run/places.ts), which adds the wait of a worker start to parked_ms; capsStartedAt (packages/engine/src/run/records.ts) adds parked_ms, and startQueued builds the session's view after the claim. So only a test is missing. (3) The test "keeps a held steer out of a reviewer session's first message (0002)" in packages/engine/test/run/intervene.test.ts sets runs.role and agents.role to reviewer. The skip in packages/engine/src/run/outcome-sessions.ts asks placeOfRun (places.ts), which, with no live agent, reads the run's newest phase step before runs.role; reopenForRound (packages/engine/src/run/rounds.ts) writes phase review for a review and phase build for a fix round. No test covers that path. The `dipo resume` wording of the pause message stays with DIPO-155.

```dipo
branch: "DIPO-234/steer-code-and-review-skip-tests"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) index.test.ts: OFFICE_ERROR_CODES ends with story.notSteerable, and the retryable test shows it not retryable; tsc -b passes with STEER_ERROR_CODES and SteerErrorCode removed"
    - kind: "automated"
      check: "(unit) a paused run whose worker exited is resumed while the worker place is taken, waits a set time, then starts on a drain; elapsedMs from runTotals with capsStartedAt leaves out both the paused time and the wait"
    - kind: "automated"
      check: "(unit) a run reopened for a review by reopenForRound keeps a held steer out of the next session's first message and pending; a run reopened for a fix round sends it with the developer session's first message and resolves it"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 In packages/contract/src/errors.ts story.notSteerable is the last entry of OFFICE_ERROR_CODES, with its since-minor-1 note (DIPO-163, 0020 section 9) moved into that list's comment; STEER_ERROR_CODES and SteerErrorCode are removed, and KnownErrorCode is the union of the four remaining lists
- [ ] #2 packages/contract/src/index.test.ts expects story.notSteerable as the last entry of OFFICE_ERROR_CODES, with DIPO-163 named in that test's title, and its retryable test, which spreads OFFICE_ERROR_CODES, shows story.notSteerable not retryable
- [ ] #3 A test in packages/engine/test/run/intervene.test.ts pauses a run, lets its worker exit after the 10 minutes, resumes it while the worker place is taken, moves the clock on while it waits, frees the place and drains, and shows that elapsedMs of runTotals with capsStartedAt of the run after the start leaves out both the paused time and the wait; the file comment of packages/engine/src/run/resume-paused.ts says the wait is left out through the parked_ms that claimPlace adds
- [ ] #4 A test with the run reopened for a review by reopenForRound (newest phase step review), runs.role developer and no live agent shows a held steer left out of the next session's first message and still pending
- [ ] #5 A test with the run reopened for a fix round by reopenForRound (newest phase step build) shows the held steer in the first message of the developer session that starts, and the steer resolved
<!-- AC:END -->
