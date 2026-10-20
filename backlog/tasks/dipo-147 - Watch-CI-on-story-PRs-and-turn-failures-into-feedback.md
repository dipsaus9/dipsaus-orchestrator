---
id: DIPO-147
title: Watch CI on story PRs and turn failures into feedback
status: Ready
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-20 08:42'
labels:
  - 'tier:M'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-139
  - DIPO-141
  - DIPO-144
  - DIPO-133
  - DIPO-146
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
  - packages/engine/test/run/
priority: high
type: feature
ordinal: 136000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the PR poll waits for the office's and the host's required checks on the pushed head, builds CI feedback items with job log tails, and parks verify-failing with cause ci when the red heads reach the run's CI cap.

Context: implements ADR 0019 section 7 (which checks, timing against the review, polling, logs) and the CI rows of section 8 (items, signatures, caps; maintainer spike answers 2 and 10). The merge slot today waits for hard-coded check names (0019 fact 2), which DIPO-133 makes an office setting.

DIPO-142 added the run_steps kind ci ("a pushed head whose required checks were red", migration 0034) that the final run_outcomes row counts as ci_attempts. This story appends one ci step per red pushed head, the same count it parks on at the run's CI cap: runs.ci_cap, which DIPO-146 snapshots from mergeSlot.ciAttempts at run start, plus the run's ciAttempt grants, read through runCaps (packages/engine/src/run/caps.ts); DIPO-148's fix round appends none.

The story PR body's status block (DIPO-144, statusSection in packages/engine/src/story-pr/body.ts) has no required-checks line yet; 0019 section 3 gives it one with each check's name and state, which this story adds when it reads the checks.

```dipo
branch: "DIPO-147/watch-ci-on-story-prs"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) story-pr/body.ts: the status block lists each required check with its state and is rewritten when a check changes"
    - kind: "automated"
      check: "(unit) with storyPr.open false the PR poll makes no gh pr checks call and builds no CI item for the story"
    - kind: "automated"
      check: "(unit) the required set joins office and host checks and treats an unreported check as pending"
    - kind: "automated"
      check: "(unit) poll scheduling: a final head is skipped, a stuck head raises one ci.stuck and slows to 10 minutes"
    - kind: "automated"
      check: "(unit) with a fake host, a failed job becomes one CI item with its tail, locations and signature, and ci-ok gets no log"
    - kind: "automated"
      check: "(unit) the second red head parks verify-failing with cause ci at a runs.ci_cap of 2, and with one ciAttempt grant the park comes at the third red head"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The required checks of a head are the union of the office's mergeSlot.requiredChecks and the checks the host marks required; a check the host has not reported counts as pending, and both sets must pass on the head the engine pushed
- [ ] #2 One PR poll per office runs every polling.prStateSeconds for each story PR with unfinished required checks on its pushed head, an unposted review comment or no PR yet, using one gh pr view and one gh pr checks per PR, and does not poll a head whose checks are final until the head changes; with storyPr.open false the poll makes no gh pr checks call and builds no CI item for the story
- [ ] #3 A head whose required checks are not final after mergeSlot.checksWaitMinutes raises one ci.stuck notice and is then polled every 10 minutes, and the waiting story holds no session place
- [ ] #4 Each failed Actions check becomes a CI feedback item with check name, job, failing step names, the log tail cut to the 0014 feedback budget and parsed file:line locations, signed over check name, job name, failing step names and locations; an aggregate check explained by other failed jobs is named without a log, and logs are fetched once per failed head
- [ ] #5 The red head that reaches the run's CI cap (runs.ci_cap plus the run's ciAttempt grants, read through runCaps) parks the story verify-failing with cause ci; a config edit of mergeSlot.ciAttempts after the run started does not change it
- [ ] #6 The story PR body's status block shows each required check with its state, as 0019 section 3 gives it, rewritten with the body when a check changes
<!-- AC:END -->
