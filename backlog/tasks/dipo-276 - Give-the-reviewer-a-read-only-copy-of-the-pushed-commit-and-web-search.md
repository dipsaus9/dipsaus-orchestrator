---
id: DIPO-276
title: Give the reviewer a read-only copy of the pushed commit and web search
status: In Review
assignee: []
created_date: '2026-10-21 13:44'
updated_date: '2026-10-21 22:26'
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
  - packages/engine/src/workers/types.ts
  - packages/engine/src/run/launch.ts
  - packages/engine/src/workers/claude-cli/launch-checks.ts
  - packages/engine/src/run/reviews.ts
  - packages/engine/src/run/index.ts
  - packages/engine/src/prompts/review.ts
  - packages/engine/src/prompts/index.ts
  - packages/engine/src/prompts/templates.ts
  - packages/engine/src/prompts/task/review-commit.md
  - packages/engine/src/prompts/contract/review.md
  - packages/engine/src/prompts/roles/reviewer.md
  - packages/engine/test/prompts/review.test.ts
  - packages/engine/test/prompts/golden/system-review-reviewer.md
  - packages/engine/test/workers/plan.test.ts
  - packages/engine/test/workers/launch-checks.test.ts
  - packages/engine/test/workers/launch-fixtures.ts
  - packages/engine/test/workers/self-test.test.ts
  - packages/engine/test/run/adapter.test.ts
  - packages/engine/test/run/reviews.test.ts
  - packages/daemon/src/runs.ts
  - packages/daemon/src/foreground.ts
  - packages/daemon/test/unit/box-runs.test.ts
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
- [x] #1 dipo checks the pushed commit out into a fresh read-only folder for each review round and removes it afterwards
- [x] #2 The reviewer's tools are read-only on that folder plus web search; no shell, no write, no gh
- [ ] #3 The reviewer gets what 0019 section 4 gives it plus the report evidence, never the builder's reasoning or transcript
- [x] #4 Tests cover the tool set and the folder's lifetime
- [x] #5 The reviewer session's working directory is outside the read-only copy, and it loads no settings, hooks or instruction files from it (0021 section 14); the copy is reachable only through the read tools, shown by a test with a copy that holds such files
<!-- AC:END -->
