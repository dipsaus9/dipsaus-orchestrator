---
id: DIPO-152
title: Post each review round's report on the story PR
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-17 13:10'
labels:
  - 'tier:S'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-141
  - DIPO-144
  - DIPO-146
  - DIPO-147
references:
  - packages/engine/src/story-pr/
  - packages/engine/src/review/
  - packages/engine/test/story-pr/
priority: high
type: feature
ordinal: 141000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: after each review round the engine posts one code-built comment in the format of ADR 0019 section 3, with every value from the copied env files replaced by [redacted], never edits it, stores its URL on the verdict, and retries a failed post without holding the gate.

Context: implements the review comments of ADR 0019 section 3 (spike answer 5), including what a public comment can reveal and the maintainer decision of 2026-10-17 that env values are redacted before posting; the rule that worktree env files hold development secrets only stays (0008 open question 8).

```dipo
branch: "DIPO-152/post-review-report-on-story-pr"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(golden) the rendered comment for a blocked round with an unverified finding"
    - kind: "automated"
      check: "(unit) an env value inside a quote, the evidence and the summary is replaced by [redacted], and the stored verdict is unchanged"
    - kind: "automated"
      check: "(unit) an unreadable copied env file holds the comment back with pr.commentFailed"
    - kind: "automated"
      check: "(unit) the 60,000 character cap cuts advisory findings first"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 After each review round the engine posts one comment built by code from the stored verdict in the section 3 format (heading with round and verdict, commit, reviewer model and effort, time, criteria, findings with unverified ones marked, summary) holding no prompt text, token counts, cost, session or run ids or worker report
- [ ] #2 A comment is posted once and never edited or deleted, a later round gets a new comment, an approval carried to a new head posts nothing, and the comment URL is stored on the verdict
- [ ] #3 A comment over 60,000 characters is cut, advisory findings first, with a marker
- [ ] #4 After the cap, every value read as a KEY=value line from the env files dipo copied into the worktree (the copy entries of worktree.files) is replaced by [redacted] across the whole comment while the stored verdict keeps the reviewer's text; an unreadable copied env file holds the comment back with a pr.commentFailed notice
- [ ] #5 A failed post raises pr.commentFailed and is retried by the PR poll, never blocking or delaying the gate, a fix round or a merge
<!-- AC:END -->
