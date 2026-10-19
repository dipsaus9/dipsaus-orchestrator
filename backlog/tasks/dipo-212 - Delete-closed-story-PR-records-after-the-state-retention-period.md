---
id: DIPO-212
title: Delete closed story PR records after the state retention period
status: Ready
assignee: []
created_date: '2026-10-19 14:43'
updated_date: '2026-10-19 15:14'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/retention/run.ts
  - packages/engine/test/retention/
priority: medium
type: bug
ordinal: 212000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the retention pass deletes story_prs rows of PRs closed or merged more than stateDays ago, as its policy says, and keeps every open PR.

Context: review of DIPO-144 (PR #224). packages/engine/src/retention/policy.ts registers story_prs at tier S with the rule "closed more than stateDays ago; an open PR is kept", and DIPO-144 writes closed_at when a PR merges or closes on the host. packages/engine/src/retention/run.ts prunes backlog_prs that way (rows("backlog_prs", "closed_at < $cutoff", ...)) but has no line for story_prs, so the rows are never deleted.

```dipo
branch: "DIPO-212/story-prs-retention"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a retention pass deletes a story_prs row closed before the state cutoff and keeps one closed after it and one still open"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 packages/engine/src/retention/run.ts deletes story_prs rows whose closed_at is before the state cutoff, next to the backlog_prs line, and counts them in the pass result
- [ ] #2 A test in packages/engine/test/retention/ keeps an open story PR and one closed after the cutoff, and deletes one closed before it
<!-- AC:END -->
