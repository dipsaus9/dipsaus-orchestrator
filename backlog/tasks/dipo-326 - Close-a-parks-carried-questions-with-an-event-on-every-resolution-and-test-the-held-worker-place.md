---
id: DIPO-326
title: >-
  Close a park's carried questions with an event on every resolution, and test
  the held worker place
status: Refined
assignee: []
created_date: '2026-10-23 10:28'
labels:
  - follow-up
milestone: m-2
dependencies: []
references:
  - packages/engine/src/run/park-resume.ts
  - packages/engine/src/run/park.ts
  - packages/engine/src/hooks/permissions.ts
  - packages/engine/test/hooks/worker-questions.test.ts
  - packages/engine/test/run/
priority: low
type: task
ordinal: 311000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up of the DIPO-159 review (advisories). When a park is resolved by drop, reconcile, discard or another non-resume path, the trigger of migration 50 expires its carried questions in SQL without a question.closed change-log entry, so a client that follows events may keep showing the question open. A worker waiting on a live question keeps its office place only because its process does not exit; no test checks that place.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every park resolution that expires carried questions writes a question.closed entry for each, as the resume path does
- [ ] #2 A test shows the office worker place stays taken during a live question wait and is freed only after the park or the exit
<!-- AC:END -->
