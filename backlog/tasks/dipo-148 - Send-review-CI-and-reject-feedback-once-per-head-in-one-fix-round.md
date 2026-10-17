---
id: DIPO-148
title: 'Send review, CI and reject feedback once per head in one fix round'
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-17 12:52'
labels:
  - 'tier:M'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-146
  - DIPO-147
references:
  - packages/engine/src/run/
  - packages/engine/src/prompts/
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/src/retention/policy.ts
  - packages/engine/test/run/
  - packages/engine/test/db/
priority: high
type: feature
ordinal: 137000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: feedback items with their text are stored in feedback_items, sent once per head with repeats marked, and batched into one fix round that moves the story to In Progress and resumes the developer session in the worker place.

Context: implements ADR 0019 section 8 (sources, one round per head, items and signatures, storage, send-once, caps per source) and the fix-round timing of section 7. Verify items already carry a sha256 signature, but nothing records which were sent (0019 fact 10).

```dipo
branch: "DIPO-148/send-feedback-once-per-head"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) an item for one head is sent once across a simulated daemon restart, and the same signature on a new head is marked as a repeat"
    - kind: "automated"
      check: "(unit) a fix round waits for both the verdict and final checks of its head and sends one message"
    - kind: "automated"
      check: "(unit) review item signatures ignore free text and collapse whitespace in quotes"
    - kind: "automated"
      check: "(migration) feedback_items exists with retention tier S"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A feedback_items table (run, item id, source, signature, head commit, round, sent time, the carrying intent, rendered text of at most 3,000 characters; retention tier S) is written in the same transaction as the steer intent that sends the items
- [ ] #2 Review items carry the section 8 evidence and signature (criterion number and status; or kind, file and the whitespace-collapsed quote; or kind and test-plan entry number), and a maintainer reject item is the note verbatim, keyed on the gate id
- [ ] #3 An item is sent at most once per head commit across polls and daemon restarts; the same signature on a later head is sent again marked still failing after your last change, and two sends in a row of one verify or CI signature raise the same-failure watchdog signal
- [ ] #4 All feedback for one head goes in one user message; the fix round waits until that head's verdict is in and its required checks are final or past the wait cap, reopens the run in the worker place, commits <ID>: status In Progress, and resumes the developer session when canResume holds, else starts a new session with a handoff
- [ ] #5 Advisory findings never start a fix round on their own and are listed as optional when a fix round starts for another reason
<!-- AC:END -->
