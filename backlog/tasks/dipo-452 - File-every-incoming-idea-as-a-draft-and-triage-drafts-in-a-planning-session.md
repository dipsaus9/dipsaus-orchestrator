---
id: DIPO-452
title: File every incoming idea as a draft and triage drafts in a planning session
status: Refined
assignee: []
created_date: '2026-11-05 20:51'
labels:
  - 'tier:L'
milestone: m-3
dependencies:
  - DIPO-450
  - DIPO-443
references:
  - packages/engine/src/run/proposals.ts
  - packages/engine/src/overview/proposals.ts
  - packages/engine/src/overview/desk.ts
  - packages/engine/src/review/verdict.ts
  - packages/engine/src/backlog/lane/propose.ts
  - packages/engine/src/backlog/runner.ts
  - packages/contract/src/office.ts
  - packages/cli/src/
  - packages/tui/src/
  - docs/decisions/0020-park-and-resume.md
  - docs/decisions/0002-review-and-testing.md
priority: medium
type: feature
ordinal: 425000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want every incoming idea filed as a draft by itself, and a triage session where I promote or drop each draft, so that only work I approve gets a real id and the backlog holds only goals I set.

M3 (0022), the maintainer's answer to scope creep. Needs DIPO-450 (filing through the lane) and DIPO-443 (the TUI key).

Sources: a worker's proposal (today it waits on the desk for proposal.accept, packages/engine/src/run/proposals.ts and packages/engine/src/overview/proposals.ts; the accept step goes), a reviewer's advisory finding (today only stored in review_verdicts.findings and listed in the PR comment, packages/engine/src/review/verdict.ts, packages/engine/src/review/comment.ts), the maintainer's quick idea (`dipo idea "<text>"` and a TUI key), and a planning session's aside. A worker's decision note (DIPO-404) is not an idea: it stays on the desk with its own dismiss. An advisory is filed once: a finding is the same when its review run, file and text match. Each draft records its origin and source story, kept for retro (DIPO-453). Drafts are filed through the existing propose lane kind (packages/engine/src/backlog/lane/propose.ts), with its text cleaning.

Triage: a planning session of kind triage lists the drafts with their origin; on confirm dipo promotes a draft to a real story (Backlog's draft promote, packages/engine/src/backlog/runner.ts; emits story.renumbered) through the lane, or drops it (archive). Built by dipo where it can (maintainer's choice, 2026-11-05); a builder agent takes over if dipo gets stuck.

```dipo
branch: "DIPO-452/drafts-inbox-and-triage"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a worker proposal, a reviewer advisory finding, a quick idea and a session aside each become one draft with its origin; the same advisory again files no second draft"
    - kind: "automated"
      check: "(unit) proposal.accept is gone and the desk shows no proposal items, while a decision note still shows on the desk and its dismiss still closes it"
    - kind: "automated"
      check: "(unit) a confirmed promote turns the draft into a real story with a frozen branch and emits story.renumbered; a confirmed drop archives it"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A worker's proposal is filed as a draft by itself, and the desk's proposal items and proposal.accept are removed
- [ ] #2 A worker's decision note still shows on the desk and is closed by its own dismiss
- [ ] #3 Each advisory finding of a review is filed as one draft, and a finding whose review run, file and text match one already filed is not filed again
- [ ] #4 The maintainer files a quick idea as a draft with dipo idea and with a TUI key, without a session
- [ ] #5 Each draft records its origin (worker proposal, reviewer advisory, quick idea or session aside) and its source story, kept after promotion
- [ ] #6 A triage session lists the drafts with their origin, and on confirm promotes a draft to a real story through the lane or drops it
- [ ] #7 ADRs 0020 and 0002 describe proposals and advisories becoming drafts, each with one Replaced line
<!-- AC:END -->
