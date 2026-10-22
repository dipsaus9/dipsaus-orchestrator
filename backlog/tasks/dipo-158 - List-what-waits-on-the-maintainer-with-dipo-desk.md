---
id: DIPO-158
title: List what waits on the maintainer with dipo desk
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-22 11:31'
labels:
  - 'tier:M'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-155
  - DIPO-151
references:
  - packages/contract/src/
  - packages/contract/schema/
  - packages/engine/src/views/
  - packages/engine/src/reads/
  - packages/cli/src/
  - packages/engine/test/views/
priority: high
type: feature
ordinal: 147000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: office.desk returns the items that wait on the maintainer in a fixed order with the command to type for each, and dipo desk prints them in plain text, so the maintainer sees in one list what to do next.

Context: implements ADR 0020 section 12 (the plain-text desk: the office.desk read, its order and the CLI) with the desk rows 0019 asks for (sections 9, 11 and 14). Later M1a stories add their item kinds to the same read (leftovers, proposals, scope requests). 0005 and 0009 forbid clients from deriving status, so the order is engine code.

```dipo
branch: "DIPO-158/dipo-desk-plain-text"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the desk order over constructed items from every group, with dependents breaking ties before age"
    - kind: "automated"
      check: "(unit) a review-blocked park gives one row with both actions and an autorelease: pending gate gives no dipo approve"
    - kind: "automated"
      check: "(unit, cli) dipo desk output for an empty desk and for the section 12 example items"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 office.desk { office } returns DeskItem[] with kind, story, key, question, gate, pr from story_prs, proposal, reason, cause, detail, since, blocks and actions { command, cli }, where cli is the exact command line built by code; the read is behind capability flag desk
- [ ] #2 Items are ordered in the six groups of section 12 (questions with a waiting worker, merge gates, parks by decision then direction then restart, hand actions, proposals, held by you) and within a group by number of dependents, then oldest
- [ ] #3 A review-blocked story is one PARKED row offering dipo resume --note and dipo approve --note, and a gate held by autorelease: pending offers a hand merge on GitHub and no dipo approve
- [ ] #4 dipo desk [--office <id>] [--json] prints a count line, one line per item and an indented line with the command, in plain text; --json prints the read's result; an empty desk prints Nothing waits on you.; the exit code is 0
- [ ] #5 The contract carries the office.desk read and the DeskItem shape
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
From DIPO-299 (2026-10-22): a box run whose branch tip moved at done now parks interrupted with cause build, not verify-failing with cause refused.
<!-- SECTION:NOTES:END -->
