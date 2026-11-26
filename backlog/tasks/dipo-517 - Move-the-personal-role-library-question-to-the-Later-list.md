---
id: DIPO-517
title: Move the personal role library question to the Later list
status: Done
assignee: []
created_date: '2026-11-26 14:37'
updated_date: '2026-11-26 15:01'
labels:
  - 'tier:S'
  - 'role:developer'
milestone: m-4
dependencies: []
references:
  - docs/vision.md
  - docs/decisions/0003-milestones-and-quality-bar.md
modified_files:
  - docs/decisions/0003-milestones-and-quality-bar.md
  - docs/vision.md
type: docs
ordinal: 478000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want the open question about a personal library of roles moved to the later list so that the roster milestone can close without a question that says it is decided with that milestone.

docs/vision.md:145 lists an open question: should there also be a personal library of tuned roles to copy into a new office as a template? It ends with 'Decided with M4.' The maintainer decided on 2026-11-26 to defer it, not answer it: roles stay per office only (0001, 0017).

- In vision.md, Open questions: the role library entry no longer says it is decided with M4. It says the question was deferred to the Later list on 2026-11-26.
- In decision 0003, the Later list gets one line for the role library.

## What it does not do
- Does not decide whether a role library is wanted
- Does not mark M4 Done or change the M4 line in 0003; that comes in a later close story

## ADR lines that change
- docs/decisions/0003-milestones-and-quality-bar.md, Milestones, Later, with no milestone yet: new line: - a personal library of tuned roles to copy into a new office as a starting template (deferred from M4, 2026-11-26).

## Risks and choices
None.

```dipo
branch: "DIPO-517/move-personal-role-library-question"
unknowns: []
test_plan:
  not_applicable: "Two lines of prose in docs change, and no code or test reads them."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 docs/vision.md no longer says the role library question is decided with M4, and says it was deferred to the Later list in 0003 on 2026-11-26
- [x] #2 The Later list in docs/decisions/0003-milestones-and-quality-bar.md has a line for a personal library of tuned roles to copy into a new office
- [x] #3 No other line of either file changes
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-26 15:01 UTC
- Criteria met: 3 of 3 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 1, failed 0
- Budget used: 26,092 of 300,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 0
<!-- SECTION:FINAL_SUMMARY:END -->
