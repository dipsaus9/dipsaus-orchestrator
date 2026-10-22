---
id: DIPO-152
title: >-
  Keep dipo's story PR complete: open a missed PR, show the worker's done
  report, keep the status block true and post each review round's report
status: Ready
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-22 19:12'
labels:
  - 'tier:M'
  - 'slice:m1a'
  - box
  - cutover
milestone: m-1
dependencies:
  - DIPO-141
  - DIPO-144
  - DIPO-219
  - DIPO-147
  - DIPO-296
references:
  - packages/engine/src/box/door.ts
  - packages/engine/src/review/
  - packages/engine/src/run/records.ts
  - packages/engine/src/story-pr/
  - packages/engine/src/story-pr/body.ts
  - packages/engine/src/story-pr/prs.ts
  - packages/engine/src/story-pr/records.ts
  - packages/engine/test/story-pr/
  - packages/engine/test/story-pr/prs.test.ts
  - packages/engine/test/story-pr/title-body.test.ts
priority: high
type: feature
ordinal: 141000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a story that is In Review without a story PR gets one from the PR poll, also when its run already ended as reviewed; the notes, deviations and proposals of a box worker's done report are stored with the run and shown in dipo watch, the TUI and the story PR; the PR's status block shows the stored review verdict and who merges; and after each review round the engine posts one code-built comment in the format of ADR 0019 section 3, with every value from the copied env files replaced by [redacted], never edits it, stores its URL on the verdict, and retries a failed post without holding the gate.

Context: implements the review comments of ADR 0019 section 3 (spike answer 5), including what a public comment can reveal and the maintainer decision of 2026-10-17 that env values are redacted before posting; the rule that worktree env files hold development secrets only stays (0008 open question 8).

The story PR body's status block (DIPO-144, statusSection in packages/engine/src/story-pr/body.ts) shows the review as pending only; 0019 section 3 gives it the review round states, which this story adds with the round comments.

From DIPO-304: in the box retest of the verify redesign (DIPO-275: DIPO-300 run run_01M5HS75YC89DVXQAEMFFT01P5 and DIPO-122 run run_01M5HY626T0A2FGPR3SEK1ERKY, 2026-10-22) DIPO-300's review finished while story PRs were off; after they were switched on, runsWithoutPr never picked the run up because it only selects runs with end_kind in-review and a push after the end. The PR had to be opened by hand (#337).

From DIPO-305: in the box retest of the verify redesign (DIPO-275: DIPO-300 run run_01M5HS75YC89DVXQAEMFFT01P5 and DIPO-122 run run_01M5HY626T0A2FGPR3SEK1ERKY, 2026-10-22) DIPO-122 criterion 4 asked for a decision note proposed in the PR; the worker has no gh and the PR body is built by code, and the done report is stored nowhere, so the criterion could not be met. Related: DIPO-166 (file proposals), DIPO-167 (structured summary), DIPO-186 (decision-record notes as data).

From DIPO-306: in the box retest of the verify redesign (DIPO-275: DIPO-300 run run_01M5HS75YC89DVXQAEMFFT01P5 and DIPO-122 run run_01M5HY626T0A2FGPR3SEK1ERKY, 2026-10-22) PR #339 kept "review: pending" after the reviewer approved, and said "dipo merges after review and green required checks" while the merge slot (DIPO-150) is not built and the maintainer side merges.

```dipo
branch: "DIPO-152/story-pr-complete"
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
    - kind: "automated"
      check: "(unit) a run that ended as reviewed while story PRs were off gets its story PR at the next poll, with the stored verdict in the status block"
    - kind: "automated"
      check: "(unit) a box worker's done report notes, deviations and proposals are stored with the run, cleaned and capped, and shown in dipo watch at the run end"
    - kind: "automated"
      check: "(unit) the story PR body has a section with the done report, built by code and marked as the worker's words"
    - kind: "automated"
      check: "(unit) after a review round the body's review line shows the stored verdict and round, and the merge line says the maintainer merges until the merge slot does"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 After each review round the engine posts one comment built by code from the stored verdict in the section 3 format (heading with round and verdict, commit, reviewer model and effort, time, criteria, findings with unverified ones marked, summary) holding no prompt text, token counts, cost, session or run ids or worker report
- [ ] #2 A comment is posted once and never edited or deleted, a later round gets a new comment, an approval carried to a new head posts nothing, and the comment URL is stored on the verdict
- [ ] #3 A comment over 60,000 characters is cut, advisory findings first, with a marker
- [ ] #4 After the cap, every value read as a KEY=value line from the env files dipo copied into the worktree (the copy entries of worktree.files) is replaced by [redacted] across the whole comment while the stored verdict keeps the reviewer's text; an unreadable copied env file holds the comment back with a pr.commentFailed notice
- [ ] #5 A failed post raises pr.commentFailed and is retried by the PR poll, never blocking or delaying the gate, a fix round or a merge
- [ ] #6 The story PR body's status block shows the review round state, as 0019 section 3 gives it, rewritten with the body after each round
- [ ] #7 (from DIPO-304) runsWithoutPr also selects runs that ended as reviewed whose story is still In Review with a live claim and no story PR
- [ ] #8 (from DIPO-304) The PR opened then carries the stored review verdict in its status block
- [ ] #9 (from DIPO-304) A test switches story PRs on after the review and shows the PR opens on the next poll
- [ ] #10 (from DIPO-305) The done report's notes, deviations and proposals are stored with the run, cleaned and capped as door messages are
- [ ] #11 (from DIPO-305) dipo watch and the TUI show them when the run ends
- [ ] #12 (from DIPO-305) The story PR body gets a section with them, built by code, marked as the worker's words
- [ ] #13 (from DIPO-305) Tests cover storage, the cap and the PR section
- [ ] #14 (from DIPO-306) After a review round the PR body's review line shows the stored verdict and round
- [ ] #15 (from DIPO-306) Until the merge slot merges story PRs, the merge line says the maintainer merges
- [ ] #16 (from DIPO-306) Tests cover both lines
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-22: combined from DIPO-304, DIPO-305, DIPO-306 (maintainer, M1 speed-up)
<!-- SECTION:NOTES:END -->
