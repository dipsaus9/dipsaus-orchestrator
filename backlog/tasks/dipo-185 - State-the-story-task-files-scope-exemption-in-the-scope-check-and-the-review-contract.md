---
id: DIPO-185
title: >-
  State the story task file's scope exemption in the scope check and the review
  contract
status: Refined
assignee: []
created_date: '2026-10-17 17:24'
updated_date: '2026-10-17 17:24'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies:
  - DIPO-145
references:
  - packages/engine/src/run/verify-commit.ts
  - packages/engine/test/run/
  - packages/engine/src/prompts/
  - packages/engine/test/prompts/
priority: medium
type: enhancement
ordinal: 174000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the worker, the reviewer and the maintainer can read that the story's own task file is written by dipo and exempt from scope, so nobody has to guess whether its change in a story PR is a scope violation.

Context: the first M1a run, DIPO-123 (run_01M55CQA2468N35QN7V2D5S9MY). dipo's run commits the story's own task file (status In Review, checked criteria, notes) although it is outside the story's References, and the PR's reviewer had to guess whether that counts as scope. The engine already exempts it: checkScope in packages/engine/src/run/verify-commit.ts skips the path equal to the task file, and the In Review status is committed alone as `<ID>: status In Review`. Nothing says so where people look. The scope-violation detail (scopeDetail) names only the declared scope, the worker's L1 (packages/engine/src/prompts/contract/implement.md) says a file outside <scope> is rejected, and the review contract does not exist yet.

DIPO-145 adds the review L1 (prompts/contract/review.md) and the review task message, so this story depends on it. 0019 section 4 already leaves the task file out of the reviewer's diff and tells the reviewer the engine has checked which paths changed, so no ADR changes. The hand reviews on PRs today use a plugin agent outside this repository, which this story does not change.

```dipo
branch: "DIPO-185/task-file-scope-exemption"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) checkScope with the story's own task file, another story's task file and backlog/config.yml, and the scope-violation detail text"
    - kind: "automated"
      check: "(golden) the implement and review L1 texts hold the task file exemption"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 checkScope exempts exactly the story's own task file: tests show that another story's task file and a different file under backlog/ are outside scope, and the story's own task file is not
- [ ] #2 A scope-violation detail lists the declared scope and says that the story's own task file, written by dipo, is exempt
- [ ] #3 The worker's L1 Scope section says dipo writes the story's own task file (status, checked criteria) and the worker does not; the golden file is updated
- [ ] #4 The review L1 from DIPO-145 says the story's own task file is written by dipo, is exempt from scope and is never a scope finding, and the review task message's changed-path list leaves it out or marks it as written by dipo; the golden files are updated
<!-- AC:END -->
