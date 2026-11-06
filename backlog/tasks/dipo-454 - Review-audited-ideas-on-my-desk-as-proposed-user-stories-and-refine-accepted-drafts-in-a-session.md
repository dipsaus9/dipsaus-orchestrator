---
id: DIPO-454
title: >-
  Review audited ideas on my desk as proposed user stories and refine accepted
  drafts in a session
status: Parked
assignee: []
created_date: '2026-11-06 09:37'
updated_date: '2026-11-06 15:19'
labels:
  - 'tier:L'
milestone: m-3
dependencies:
  - DIPO-452
  - DIPO-450
  - DIPO-443
references:
  - packages/engine/src/overview/desk.ts
  - packages/engine/src/overview/proposals.ts
  - packages/engine/src/backlog/lane/propose.ts
  - packages/engine/src/backlog/runner.ts
  - packages/contract/src/office.ts
  - packages/cli/src/
  - packages/tui/src/
  - docs/decisions/0020-park-and-resume.md
priority: medium
type: feature
ordinal: 427000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want each idea that passed dipo's audit on my desk as a proposed user story that says what was found, what is proposed and why, which I accept as a draft or dismiss, so that I decide quickly and only what I accept is refined into a story.

M3 (0022, 2026-11-06). Needs DIPO-452 (ideas and their audit), DIPO-450 (filing through the lane) and DIPO-443 (the TUI parts).

The trigger: the desk line for a worker's proposal (DIPO-444's, 2026-11-06) was cut after about 200 characters, labelled only "follow-up", and its finding was buried in "Why". The new desk item shows the proposed user story in full in its card: what was found with its evidence and source story, the Story line, what is proposed, why, and the milestone it serves or tech debt. Accept files a Backlog draft with its origin through the backlog lane (packages/engine/src/backlog/lane/propose.ts, with its text cleaning); a tech-debt draft gets no milestone and the label tech-debt. Dismiss closes it and keeps it as dismissed by the maintainer, for retro. The desk write of worker proposals, the old desk proposal items and `dipo propose accept` go (one mechanism, 0001; until this story, DIPO-452 still writes proposals to the desk); a worker's decision note (DIPO-404) is not an idea and stays on the desk with its own dismiss.

Quick idea: `dipo idea "<text>"` and a TUI key hand the maintainer's idea to the audit (DIPO-452). Triage: a planning session of kind triage lists the drafts with their origin; on confirm dipo refines a draft into a Refined story that meets the story standard (0012), with a branch named for its new id, through the lane (Backlog's draft promote, packages/engine/src/backlog/runner.ts; emits story.renumbered), or drops it (archive).

Built by dipo where it can (maintainer's choice, 2026-11-05); a builder agent takes over if dipo gets stuck.

```dipo
branch: "DIPO-454/proposed-stories-on-the-desk"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a passing idea is one desk item whose card holds found with evidence and source story, Story line, proposal, why and milestone or tech debt, in full"
    - kind: "automated"
      check: "(unit) accept files a draft with its origin through the lane, a tech-debt draft with no milestone and the label tech-debt; dismiss closes it and keeps it as dismissed"
    - kind: "automated"
      check: "(unit) worker proposals are no longer written to the desk, proposal.accept and the old proposal desk items are gone, while a decision note still shows and its dismiss closes it"
    - kind: "automated"
      check: "(unit) dipo idea and the TUI key hand the text to the audit as a quick idea"
    - kind: "automated"
      check: "(unit) a confirmed triage refine turns a draft into a Refined story that passes the story standard, with a branch named for its new id, and emits story.renumbered; a confirmed drop archives it"
park:
  reason: "budget-exceeded"
  from: "In Progress"
  note: "turn cap (--max-turns) after 301 turns"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Each idea that passed the audit is one desk item, and its card shows in full what was found with its evidence and source story, the Story line, what is proposed, why, and the milestone it serves or tech debt
- [ ] #2 Accept files a Backlog draft with its origin through the backlog lane, and a tech-debt draft has no milestone and the label tech-debt
- [ ] #3 Dismiss closes the item and keeps it as dismissed by the maintainer
- [ ] #4 The desk write of worker proposals, the old desk proposal items and proposal.accept are removed, and a worker's decision note still shows on the desk and is closed by its own dismiss
- [ ] #5 The maintainer hands a quick idea to the audit with dipo idea and with a TUI key
- [ ] #6 A triage session lists the drafts with their origin, and on confirm refines a draft through the lane into a Refined story that meets the story standard (0012), with a branch named for its new id, or drops it
- [ ] #7 ADR 0020 describes the proposed-story desk item, with one Replaced line
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parked 2026-11-06 15:19 UTC: budget-exceeded
- Detail: turn cap (--max-turns) after 301 turns
- Run: run_01M6RNA5RQ1Z23NYTZBYYB934E
- Criteria met: 0 of 7 (as the worker reported them)
- Loops: 0 of 8; CI attempts: 0 of 2
- Review rounds: 0, failed 0 of 3
- Budget used: 690,539 of 2,000,000 tokens; 301 of 300 turns; 31 of 180 minutes
- Last good commit: 334e7c3dc355c2683f7bd9bec188c317d010aeee
<!-- SECTION:NOTES:END -->
