---
id: DIPO-159
title: Wait for an answer before parking on a worker question
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-21 16:26'
labels:
  - 'tier:M'
  - 'slice:m1a'
  - needs-refinement
milestone: m-1
dependencies:
  - DIPO-155
  - DIPO-158
  - DIPO-284
references:
  - packages/engine/src/run/
  - packages/engine/src/hooks/
  - packages/engine/src/backlog/fields/
  - packages/engine/src/views/
  - packages/cli/src/
  - packages/engine/test/run/
  - packages/engine/test/hooks/
priority: high
type: feature
ordinal: 148000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker question waits questionWaitMinutes on the desk while holding the worker place, an answer goes in at once or resumes the park, dipo answer --text exists, and the answer is written to the story as a resolved unknown.

Context: implements ADR 0020 section 7 (answer before park, on the wait 0008 section 6 decides) and the ambiguous-spec rows of the section 2 matrix. Today a blocked report parks at once, no questions row is written for an ambiguous-spec park, and timeouts.questionWaitMinutes is read by nothing (0020 fact 5).

```dipo
branch: "DIPO-159/answer-before-park"
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
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: a question is live only while a TUI is connected at that moment, else the story parks (0021 section 11).
<!-- SECTION:NOTES:END -->
