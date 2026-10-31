---
id: DIPO-404
title: Let the maintainer close a decision-note proposal
status: Done
assignee: []
created_date: '2026-10-31 08:22'
updated_date: '2026-10-31 09:49'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-401
references:
  - packages/engine/src/run/proposals.ts
  - packages/engine/src/views/
  - packages/cli/src/propose-command.ts
modified_files:
  - packages/cli/src/propose-command.ts
  - packages/engine/src/overview/desk.ts
  - packages/engine/src/reconcile/held-notes.ts
  - packages/engine/src/reconcile/reconcile.ts
  - packages/engine/src/run/proposals.ts
  - packages/engine/src/run/report-data.ts
  - packages/engine/test/run/proposals.test.ts
priority: medium
type: bug
ordinal: 382000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a decision-note proposal on the desk can be dismissed, or closes by itself once the ADR holds its text.

Gap G19, 2026-10-31: two DECISION NOTE desk items (from DIPO-386 and DIPO-399) say "dipo never writes decision records: add the note by hand if you agree" and offer no dismiss, while both notes were already in the ADRs (0008, 0002), so they stay on the desk for good. 0020, 0009.

```dipo
branch: "DIPO-404/close-decision-notes"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a decision-note proposal can be dismissed, and one whose text the ADR already holds is closed"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The maintainer can dismiss a decision-note item from the desk: the desk shows its id and a dismiss action, and the dismiss acts on wherever decision notes are stored (they are not rows of the proposals table), with a test
- [x] #2 A decision note whose exact text already appears under the section it names in that ADR on the base is closed with a notice, and one whose text is absent or differs stays, with a test for each
- [x] #3 dipo still never writes a decision record itself
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-10-31 09:49 UTC
- Criteria met: 3 of 3 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 1, failed 0
- Budget used: 138,239 of 300,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 0
<!-- SECTION:FINAL_SUMMARY:END -->
