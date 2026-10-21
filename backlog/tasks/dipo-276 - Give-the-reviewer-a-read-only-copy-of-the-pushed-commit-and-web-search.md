---
id: DIPO-276
title: Give the reviewer a read-only copy of the pushed commit and web search
status: Refined
assignee: []
created_date: '2026-10-21 13:44'
updated_date: '2026-10-21 13:45'
labels:
  - 'tier:M'
  - cutover
  - box
milestone: m-1
dependencies:
  - DIPO-273
references:
  - packages/engine/src/run/review-launch.ts
  - packages/engine/src/workers/claude-cli/plan.ts
  - packages/engine/test/run/review-read-only.test.ts
  - packages/engine/test/workers/review-tools.test.ts
priority: high
type: feature
ordinal: 265000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the reviewer runs without a box, reads the story, the diff and a read-only copy of the pushed commit outside any worktree the builder touched, may search the web, and has no shell, no write and no gh.

Context: Decision 0021 (worker isolation, DIPO-263) and the probe results of DIPO-264 (tools/box-probe/RESULTS.md and the 0021 amendment of 2026-10-21).

```dipo
branch: "DIPO-276/reviewer-read-only"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 dipo checks the pushed commit out into a fresh read-only folder for each review round and removes it afterwards
- [ ] #2 The reviewer's tools are read-only on that folder plus web search; no shell, no write, no gh
- [ ] #3 The reviewer gets what 0019 section 4 gives it plus the report evidence, never the builder's reasoning or transcript
- [ ] #4 Tests cover the tool set and the folder's lifetime
<!-- AC:END -->
