---
id: DIPO-506
title: Skip the verify at done for design and docs runs
status: Refined
assignee: []
created_date: '2026-11-13 13:33'
updated_date: '2026-11-13 15:06'
labels:
  - 'tier:S'
  - 'role:developer'
milestone: m-4
dependencies:
  - DIPO-503
references:
  - packages/engine/src/run/verify-commit.ts
  - packages/engine/src/records/verify-records.ts
  - packages/engine/test/run/verify-commit.test.ts
  - docs/decisions/0002-review-and-testing.md
type: feature
ordinal: 477000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want a design or docs run to skip the office's verify when it reports done so that a run that changes only Markdown neither waits on nor loops on a code check.

At done the box runs the office's verify on the last part, and a red verify is a loop or a park (#verifyInBox, packages/engine/src/run/verify-commit.ts:525-573, called at 637 inside finishLast). DIPO-503 stores the role's kind with the run, and a run with no stored kind is a code run. The maintainer decided (planning 2026-11-13) that the verify is skipped for design runs and docs runs.

- #verifyInBox returns null without calling the verify when the run's kind is design or docs, as it does when the office names no verify (verify-commit.ts:527). The rest of #boxDone is unchanged: the gate changes, the conflict check and the end claim still run.
- The run records that the verify was skipped for its kind, so the run detail does not read as a green verify.
- A code run, and a run without a stored kind, runs the verify as today.
- CI on the story PR is unchanged.

The review-box contract says the engine ran the verify at done when the project names one (packages/engine/src/prompts/contract/review-box.md:3). That is not true for these runs; this story leaves the reviewer as it is. Amend 0002 where it says dipo runs the verify at done.

```dipo
branch: "DIPO-506/skip-verify-at-done-design-docs-runs"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "A design run at done with an office verify that would fail moves to In Review and the verify is never called"
    - kind: "automated"
      check: "A docs run at done skips the verify and its run record says it was skipped for its kind"
    - kind: "automated"
      check: "A code run and a run with no stored kind call the verify at done, and a red one is a loop"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A design run that reports done moves to In Review without the office's verify running in its box.
- [ ] #2 A docs run that reports done moves to In Review without the office's verify running in its box.
- [ ] #3 The run record of a design or docs run says the verify was skipped for its kind.
- [ ] #4 A code run and a run without a stored kind run the verify at done as before, and a red verify still loops.
- [ ] #5 Decision 0002 says the verify at done is skipped for design and docs runs.
<!-- AC:END -->
