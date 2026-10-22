---
id: DIPO-156
title: Top up a budget-exceeded story
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-22 18:16'
labels:
  - 'tier:M'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-155
  - DIPO-219
  - DIPO-205
  - DIPO-148
  - DIPO-284
  - DIPO-286
  - DIPO-289
  - DIPO-290
  - DIPO-291
  - DIPO-292
  - DIPO-294
references:
  - packages/contract/src/
  - packages/contract/schema/
  - packages/engine/src/run/
  - packages/engine/src/commands/
  - packages/engine/src/reads/describe.ts
  - packages/cli/src/
  - packages/engine/test/run/
  - packages/engine/test/reads/
  - docs/decisions/
priority: high
type: feature
ordinal: 145000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo resume <id> --budget +N% --note raises tokens, turns and minutes by the same share as a recorded grant after confirmation, resuming the developer or a fresh review, and a plain resume of a budget-exceeded park is refused naming the option.

Context: implements ADR 0020 section 4 (budget top-up; maintainer decision on budget-exceeded resume and spike answer 1) and the budget-exceeded rows of section 2. DIPO-105 parked on its turn cap with no way back in M0 (0020, real cases from the cutover).

```dipo
branch: "DIPO-156/budget-top-up-on-resume"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a top-up resume of a budget-exceeded/build park that a reopened fix round hit before any worker session sends that round's stored feedback_items first, then feedback/topup.md"
    - kind: "automated"
      check: "(unit) +50% on a tier S run adds 150,000 tokens and grows turns and minutes by half, recorded as one grant"
    - kind: "automated"
      check: "(unit) a plain resume answers resume.topUpRequired and a too small top-up answers resume.topUpTooSmall with the smallest share"
    - kind: "automated"
      check: "(unit) commands.describe lists confirmWhen budget for work.resume"
    - kind: "automated"
      check: "(unit) a review-cause top-up starts a fresh review, not a developer session"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 dipo resume <id> --budget +N% or +<tokens> with --note records a budget grant in run_grants (note, origin, client name, time, caps before and after) and raises tokens, turns and minutes by the same share of the run's starting caps; a fixed amount is tokens and turns and minutes grow by its share of the starting budget
- [ ] #2 A resume of a budget-exceeded park without --budget answers resume.topUpRequired naming --budget and the cap that fired, and a top-up after which that cap would still be reached answers resume.topUpTooSmall naming the smallest share that clears it
- [ ] #3 commands.describe gains confirmWhen and work.resume declares it for budget; the CLI shows the caps before and after and asks yes or no unless --yes is given
- [ ] #4 Cause build resumes the developer session (native when the 0014 section 6 checks pass, else a handoff) with feedback/topup.md first; cause review starts a fresh reviewer session on the same head in the reviewer place, and that round is not counted as failed
- [ ] #5 The CLI --max-turns backstop of the resumed session gets the remaining turns of the raised cap
- [ ] #6 A top-up resume of a budget-exceeded park that a reopened round hit before any worker session (DIPO-205) sends that round's undelivered feedback first, read from the run's feedback_items rows that no delivered intent carried, then feedback/topup.md
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-22: combined into DIPO-155 (maintainer, M1 speed-up)
<!-- SECTION:NOTES:END -->
