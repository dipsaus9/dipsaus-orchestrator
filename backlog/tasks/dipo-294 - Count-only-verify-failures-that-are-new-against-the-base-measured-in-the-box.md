---
id: DIPO-294
title: 'Count only verify failures that are new against the base, measured in the box'
status: To Do
assignee: []
created_date: '2026-10-22 08:30'
updated_date: '2026-10-22 08:32'
labels:
  - 'tier:M'
  - box
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/box/verify.ts
  - packages/engine/src/worktree/base-verify.ts
  - packages/engine/src/box/workers.ts
  - packages/engine/src/run/verify-commit.ts
  - packages/engine/test/box/verify.test.ts
  - packages/engine/test/worktree/base-verify.test.ts
  - docs/decisions/0021-worker-isolation.md
priority: high
type: feature
ordinal: 283000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a box run's verify passes when every failing test also fails at the story's start commit in the same image, so failures the box itself causes (for example tests that need git) no longer park a story as verify-failing, while any new failure still does.

Context: in the first box run (DIPO-275 on DIPO-248, run run_01M5H7RZ4HT6ZE49074MCH9EWF, 2026-10-22) verify in the box failed 305 tests that need git, three times, and the story parked as verify-failing although the worker's change caused none of them. The base verify (DIPO-183) runs outside the box, so it says nothing about the box. Maintainer decision of 2026-10-22: git stays out of the box; only failures that are new against the base, measured in the box, count against the story; CI on the PR runs the full suite with git. If the retest shows this is not enough, git goes into the image as well.

```dipo
branch: "DIPO-294/box-verify-new-failures"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Before the worker starts, dipo runs the office's verify at the story's start commit in the story's box (same image), and stores its failing tests keyed by base commit, image digest and verify configuration; a stored result for the same key is reused without running verify again
- [ ] #2 The base_verify section of the box worker's task message comes from that in-box result
- [ ] #3 A box verify passes when its failing tests are all in the stored base failures, and fails on any new failing test; it also fails when verify fails without a test failure it can name, times out or is killed, and when the in-box base result is not known
- [ ] #4 A pass with known base failures is recorded as such, and the PR body and the reviewer's task message name the tests that already failed on the base in the box
- [ ] #5 Tests cover: failures all on base passes; one new failure fails; a lint, format or typecheck failure fails; an unknown base result is strict; a stored base result is reused
- [ ] #6 docs/decisions/0021-worker-isolation.md gets a dated amendment (maintainer, 2026-10-22, from DIPO-275) with this rule and that git stays out of the box
<!-- AC:END -->
