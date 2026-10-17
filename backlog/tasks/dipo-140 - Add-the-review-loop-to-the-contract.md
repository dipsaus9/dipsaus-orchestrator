---
id: DIPO-140
title: Add the review loop to the contract
status: Ready
assignee: []
created_date: '2026-10-17 12:51'
updated_date: '2026-10-17 21:14'
labels:
  - 'tier:S'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-115
references:
  - packages/contract/src/
  - packages/contract/test/
  - packages/contract/schema/
priority: high
type: feature
ordinal: 129000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the contract carries Verdict.review, StoryView.pr, the story.pr event, gate.decided.review, Progress.reviewRoundCap and Progress.reviewRoundsFailed and the three new error codes, and ships gate.approve and gate.reject, so the engine and clients share the review loop's shapes.

Context: implements ADR 0019 section 15 (contract additions) with the shapes of section 14 (where verdicts show). All additions are optional or new, in the unreleased contract minor 1 (0005 section 11). Capability flag review and its command list live in the engine (DIPO-151).

```dipo
branch: "DIPO-140/review-loop-contract"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) contract schemas parse fixtures of ReviewVerdict, ReviewSummary, StoryView.pr and story.pr, and still parse payloads without the new optional fields"
    - kind: "automated"
      check: "(unit) gate.approve and gate.reject are listed as shipped commands, and the three new error codes are office errors that are not retryable"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Verdict gains an optional review field (ReviewVerdict: round, commit, code tree key, verdict, per-criterion results, findings with an unverified mark, summary, reviewer model and usage, comment URL, carried-to-later-head flag, override) and gate.decided gains an optional review (ReviewSummary: round, commit, verdict, blocking and advisory counts, comment URL)
- [ ] #2 StoryView.pr (number, URL, state), Progress.reviewRoundCap and Progress.reviewRoundsFailed are added as optional fields, and a new event story.pr carries story, key and pr
- [ ] #3 gate.approve and gate.reject are no longer provisional and carry their since; the error codes gate.notWaitingOnMaintainer, gate.handMergeOnly and gate.noteRequired exist as office errors that are not retryable
- [ ] #4 Contract tests parse a fixture of each new shape and of the old payloads without the optional fields
<!-- AC:END -->
