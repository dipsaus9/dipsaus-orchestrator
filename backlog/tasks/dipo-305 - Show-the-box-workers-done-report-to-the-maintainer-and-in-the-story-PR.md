---
id: DIPO-305
title: Show the box worker's done report to the maintainer and in the story PR
status: To Do
assignee: []
created_date: '2026-10-22 14:26'
updated_date: '2026-10-22 14:26'
labels:
  - 'tier:M'
  - box
  - cutover
milestone: m-1
dependencies:
  - DIPO-297
references:
  - packages/engine/src/box/door.ts
  - packages/engine/src/story-pr/body.ts
  - packages/engine/src/run/records.ts
  - packages/engine/test/story-pr/title-body.test.ts
priority: medium
type: feature
ordinal: 294000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the notes, deviations and proposals of a box worker's done report are stored with the run and shown in dipo watch, the TUI and the story PR, as data the code cleans and caps.

Context: in the box retest of the verify redesign (DIPO-275: DIPO-300 run run_01M5HS75YC89DVXQAEMFFT01P5 and DIPO-122 run run_01M5HY626T0A2FGPR3SEK1ERKY, 2026-10-22) DIPO-122 criterion 4 asked for a decision note proposed in the PR; the worker has no gh and the PR body is built by code, and the done report is stored nowhere, so the criterion could not be met. Related: DIPO-166 (file proposals), DIPO-167 (structured summary), DIPO-186 (decision-record notes as data).

```dipo
branch: "DIPO-305/show-done-report"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The done report's notes, deviations and proposals are stored with the run, cleaned and capped as door messages are
- [ ] #2 dipo watch and the TUI show them when the run ends
- [ ] #3 The story PR body gets a section with them, built by code, marked as the worker's words
- [ ] #4 Tests cover storage, the cap and the PR section
<!-- AC:END -->
