---
id: DIPO-147
title: Watch CI on story PRs and turn failures into feedback
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-17 12:52'
labels:
  - 'tier:M'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-139
  - DIPO-141
  - DIPO-144
  - DIPO-133
references:
  - packages/engine/src/story-pr/
  - packages/engine/src/merge-slot/checks.ts
  - packages/engine/src/run/
  - packages/engine/src/prompts/feedback.ts
  - packages/engine/src/prompts/feedback/
  - packages/daemon/src/
  - packages/engine/test/story-pr/
  - packages/engine/test/merge-slot/
  - packages/engine/test/prompts/
priority: high
type: feature
ordinal: 136000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the PR poll waits for the office's and the host's required checks on the pushed head, builds CI feedback items with job log tails, and parks verify-failing with cause ci after mergeSlot.ciAttempts red heads.

Context: implements ADR 0019 section 7 (which checks, timing against the review, polling, logs) and the CI rows of section 8 (items, signatures, caps; maintainer spike answers 2 and 10). The merge slot today waits for hard-coded check names (0019 fact 2), which DIPO-133 makes an office setting.

```dipo
branch: "DIPO-147/watch-ci-on-story-prs"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the required set joins office and host checks and treats an unreported check as pending"
    - kind: "automated"
      check: "(unit) poll scheduling: a final head is skipped, a stuck head raises one ci.stuck and slows to 10 minutes"
    - kind: "automated"
      check: "(unit) with a fake host, a failed job becomes one CI item with its tail, locations and signature, and ci-ok gets no log"
    - kind: "automated"
      check: "(unit) the second red head parks verify-failing with cause ci at the default cap"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The required checks of a head are the union of the office's mergeSlot.requiredChecks and the checks the host marks required; a check the host has not reported counts as pending, and both sets must pass on the head the engine pushed
- [ ] #2 One PR poll per office runs every polling.prStateSeconds for each story PR with unfinished required checks on its pushed head, an unposted review comment or no PR yet, using one gh pr view and one gh pr checks per PR, and does not poll a head whose checks are final until the head changes
- [ ] #3 A head whose required checks are not final after mergeSlot.checksWaitMinutes raises one ci.stuck notice and is then polled every 10 minutes, and the waiting story holds no session place
- [ ] #4 Each failed Actions check becomes a CI feedback item with check name, job, failing step names, the log tail cut to the 0014 feedback budget and parsed file:line locations, signed over check name, job name, failing step names and locations; an aggregate check explained by other failed jobs is named without a log, and logs are fetched once per failed head
- [ ] #5 The red head that reaches mergeSlot.ciAttempts parks the story verify-failing with cause ci
<!-- AC:END -->
