---
id: DIPO-159
title: >-
  Wait for a worker's question to be answered and keep the question and answer
  when the run ends
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-22 18:16'
labels:
  - 'tier:M'
  - 'slice:m1a'
  - needs-refinement
  - cutover
milestone: m-1
dependencies:
  - DIPO-155
  - DIPO-158
  - DIPO-284
  - DIPO-290
  - DIPO-149
  - DIPO-292
  - DIPO-294
  - DIPO-152
references:
  - packages/cli/src/
  - packages/engine/src/backlog/fields/
  - packages/engine/src/hooks/
  - packages/engine/src/hooks/permissions.ts
  - packages/engine/src/hooks/questions.ts
  - packages/engine/src/run/
  - packages/engine/src/run/control.ts
  - packages/engine/src/run/live-question.ts
  - packages/engine/src/run/park.ts
  - packages/engine/src/run/resume.ts
  - packages/engine/src/views/
  - packages/engine/test/hooks/
  - packages/engine/test/run/
priority: high
type: feature
ordinal: 148000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker question waits questionWaitMinutes on the desk while holding the worker place, an answer goes in at once or resumes the park, dipo answer --text exists, and the answer is written to the story as a resolved unknown; a question that is live when its run ends, or answered while the run is ending, always reaches the run's next session or its park, and no carried question stays open after its park is resolved.

Context: implements ADR 0020 section 7 (answer before park, on the wait 0008 section 6 decides) and the ambiguous-spec rows of the section 2 matrix. Today a blocked report parks at once, no questions row is written for an ambiguous-spec park, and timeouts.questionWaitMinutes is read by nothing (0020 fact 5).

From DIPO-289: DIPO-272 carries a live worker question into the park when a cap or stop ends the run. Its review (PR #320) found edges where the question or the maintainer's answer is lost.

```dipo
branch: "DIPO-159/worker-questions"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) an answer within the wait is delivered now and the minute cap leaves the wait out"
    - kind: "automated"
      check: "(unit) no answer in time parks ambiguous-spec with cause question and the later answer resumes it"
    - kind: "automated"
      check: "(unit) the answer is written as a resolved unknown, and an answer that would break R26 is delivered with a notice"
    - kind: "automated"
      check: "(unit, cli) dipo answer --text sends text and dipo answer allow still sends a decision"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A blocked report with a question stores a questions row (kind question, linked to the run) and emits question.asked at once; the worker process waits on stdin for timeouts.questionWaitMinutes while holding the worker place, and the wait is left out of the minute cap
- [ ] #2 work.answer with text during the wait delivers it now as the next user message; with no answer in time stdin closes and the story parks ambiguous-spec with cause question, the question linked to the park
- [ ] #3 A later answer through dipo answer <question> --text <answer> or dipo resume <id> --note <answer> resumes the park with feedback/answer.md first; a resume of a question park with no answer is refused
- [ ] #4 The answer is added to the story's unknowns as a resolved unknown in the unpark commit through the single field write path, or delivered without being written, with an engine.notice, when writing it would break R26
- [ ] #5 dipo answer takes --text for a worker question while permission and scope questions keep allow or deny with a reason, the help text says so, and a waiting question shows on the desk with the time left
- [ ] #6 ambiguous-spec/no-report resumes with a required note in a handoff session, and ambiguous-spec/rule-conflict with a required note, the conflict the worker named first
- [ ] #7 (from DIPO-289) An answer given after a cap or stop began, but before the run's end is ingested, is held for the next session (delivered on resume) instead of being sent to the stopping worker
- [ ] #8 (from DIPO-289) An open question that a run being ended has already let go of, but that its park has not carried yet, takes an answer as held instead of refusing it
- [ ] #9 (from DIPO-289) A worker that exits on its own while its question is live leaves the question to the park its exit decision makes; when no park follows, the question closes
- [ ] #10 (from DIPO-289) Resolving a park another way (resume, drop, reconcile) closes its carried question as expired, and a later park of the same story is tested
- [ ] #11 (from DIPO-289) Tests cover each case
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: a question is live only while a TUI is connected at that moment, else the story parks (0021 section 11).

2026-10-22: combined from DIPO-289 (maintainer, M1 speed-up)
<!-- SECTION:NOTES:END -->
