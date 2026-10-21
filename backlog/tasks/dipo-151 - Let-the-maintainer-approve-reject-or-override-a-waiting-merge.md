---
id: DIPO-151
title: 'Let the maintainer approve, reject or override a waiting merge'
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-21 16:26'
labels:
  - 'tier:M'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-140
  - DIPO-150
  - DIPO-219
  - DIPO-148
  - DIPO-251
  - DIPO-260
  - DIPO-284
  - DIPO-286
references:
  - packages/engine/src/merge-slot/
  - packages/engine/src/gate/
  - packages/engine/src/commands/
  - packages/engine/src/reads/hello.ts
  - packages/engine/src/worktree/done.ts
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/test/db/
  - packages/engine/src/features.ts
  - packages/daemon/src/
  - packages/cli/src/
  - packages/engine/test/merge-slot/
  - packages/engine/test/commands/
  - packages/engine/test/worktree/
  - docs/decisions/
priority: high
type: feature
ordinal: 140000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: merge gates open in front of the merge slot and are decided as ADR 0019 section 11 says, a review-blocked park opens an override gate whose approval needs a note, gate.approve and gate.reject work behind the review flag, dipo approve and dipo reject exist, and a hand merge closes the gate through the Done poll.

Context: implements ADR 0019 section 11 (when a merge waits for the maintainer, the gate, approve, reject, hand merge, approving past a blocked review, CLI; spike answer 3) and the capability flag of section 15; the override value of parks.resolved_how is listed in 0020 section 15. gate.approve and gate.reject are provisional today (0019 fact 8).

```dipo
branch: "DIPO-151/maintainer-merge-gates-and-override"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) each waiting condition of section 11 makes the gate wait, and none decides it by rule"
    - kind: "automated"
      check: "(unit) a story PR with an approved verdict and green checks stays out of the merge slot until its merge gate is approved"
    - kind: "automated"
      check: "(unit) override: no note answers gate.noteRequired, a note resolves the park as override and returns the story to In Review"
    - kind: "automated"
      check: "(unit) gate.approve on an autorelease: pending PR answers gate.handMergeOnly and on a rule gate answers gate.notWaitingOnMaintainer"
    - kind: "automated"
      check: "(unit, cli) dipo approve and dipo reject send the open gate id and exit 1 when nothing waits"
    - kind: "automated"
      check: "(unit) the Done poll decides an open merge gate after a hand merge"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A merge gate (gate.reached, kind merge) opens when the review approved and the required checks are green on the head, and from this story a story PR enters the merge slot of DIPO-150 only once that gate is approved, in front of the slot's own entry conditions; the gate waits for the maintainer when mergeSlot.autoMerge is false, the story is flagged test-before-merge, a criterion is marked maintainer, the story passed by override, or a hold label is on the PR, and is otherwise decided approved by rule and recorded
- [ ] #2 The gate's code-built summary names why it waits; for a flagged story it lists the manual test-plan entries and the worktree path, and the phase is test for a flagged story, merge otherwise
- [ ] #3 gate.approve decides approved by maintainer and the PR enters the slot; gate.reject (confirmation and note required) decides rejected and starts a fix round with the note; both answer gate.notWaitingOnMaintainer for a gate decided by rule, and gate.approve answers gate.handMergeOnly for a PR labelled autorelease: pending
- [ ] #4 A review-blocked park opens a merge gate summarising the blocking findings; gate.approve on it without a note answers gate.noteRequired, and with a note records a maintainer override, marks the verdict overridden, resolves the park with resolved_how override (added to the parks check by migration) and returns the story to In Review with no session
- [ ] #5 dipo approve <ID> [--note <text>] and dipo reject <ID> --note <text> (with confirmation) send the story's open maintainer gate read from story.detail, and with none print that nothing waits and exit 1; capability flag review in reads/hello.ts lists gate.approve and gate.reject
- [ ] #6 A hand merge detected by the Done poll decides the open gate approved by maintainer with the note merged on the host in the same transaction
<!-- AC:END -->
