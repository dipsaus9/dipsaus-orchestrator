---
id: DIPO-498
title: The desk never offers a merge gate that no longer holds for the PR's head
status: Refined
assignee: []
created_date: '2026-11-13 10:20'
updated_date: '2026-11-13 10:21'
labels:
  - 'tier:S'
milestone: m-3
dependencies: []
references:
  - packages/engine/src/overview/desk.ts
  - packages/engine/src/merge/commands.ts
  - packages/engine/src/merge/merger.ts
  - packages/engine/src/merge/stories.ts
  - packages/engine/src/story-pr/prs.ts
  - packages/engine/test/overview/desk.test.ts
  - packages/cli/src/desk-command.test.ts
priority: high
type: bug
ordinal: 469000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want the desk to offer a merge approval only when it can be given, so that I never try an action dipo then refuses.

Bug, seen 2026-11-13: DIPO-489's merge gate gat_01M7A5QYM754QZGYQ9CQABZD3Q opened for PR #684 at head 82b23abda1c8 (it changes the decision records, so it waits for the maintainer). dipo then merged main into the branch, resolved a conflict and pushed 52b4acfb94e1; the worker went on in phase build. The desk (TUI and `dipo desk`) kept the MERGE item with `dipo approve DIPO-489`, and the approve answered `gate.notWaitingOnMaintainer: ... it decides about 82b23abda1c8, and the PR is at 52b4acfb94e1 now.`

Cause, on main:
- The desk lists every open merge gate that waits on the maintainer (`#openMergeGates`, packages/engine/src/overview/desk.ts:672-682) and offers `dipo approve` on each (`#mergeGate` :702-731; the review-blocked park row's `dipo approve --note` :784-797), without asking whether the gate still holds for the PR's head.
- `gate.approve` and `gate.reject` refuse such a gate (`#forPrHead`, packages/engine/src/merge/commands.ts:240-255) through `holds`, which is `AutoMerge.gateHolds` (packages/engine/src/merge/merger.ts:154-163, `StoryMerges.gateHolds` packages/engine/src/merge/stories.ts:624-639): its own head, or a head whose code tree has the gate head's verdict (a task-file-only commit on top).
- A gate that stops holding is never closed when the PR moves. Open gates of a run close as superseded only when a new gate opens (`#openGate`, stories.ts:704), which happens when the new head has a passed verdict and its checks (`#gateFor` :641-673 from `#approvedGate` :406-432), on a foreign head (:938-943) or on a wait label (:1007-1010). Until then the stale gate stays open for the whole build and review of the new head, and forever when that never comes (the run parks or ends).

The fix, one mechanism: when dipo records a new head for a story PR (`StoryPrs` sync after a push, packages/engine/src/story-pr/prs.ts:895-920), every open merge gate of the run that does not hold for the new head by `AutoMerge.gateHolds` (the function `gate.approve` uses; no second rule) closes as superseded, with the note "superseded: the PR head moved to <short head>". The desk keeps listing the open gates as it does, so it never offers a gate approve would refuse. When the hold check fails (git error), the gate stays open and approve's own check still refuses it.

On the desk the story then shows nothing for that gate: its run is on the floor in build or review (0009), or on its PARKED row. When the new head's gate opens, the MERGE item shows with that gate.

Replaces: the stale merge gate left open from the PR's move until a later gate opens (the `#openGate` close stays for gates that still hold).

Not a guard: what merges does not change; `gate.approve` and `gate.reject` already refuse a gate that does not hold and keep doing so (R30 does not apply). ADRs need no line: 0002 and 0020 already say the desk lists the gates that wait for the maintainer, and a gate for an old head no longer waits for anyone.

Tier S: one close at the PR head record through an existing check, and tests.

```dipo
branch: "DIPO-498/close-stale-merge-gate"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit, desk) an open merge gate that waits on the maintainer at the PR's head shows as MERGE with dipo approve and dipo reject"
    - kind: "automated"
      check: "(unit, story-pr sync) the PR moves by a code commit: the gate closes as superseded with the new head in its note, the desk has no MERGE item for it, and gate.approve on it answers gate.notWaitingOnMaintainer"
    - kind: "automated"
      check: "(unit, story-pr sync) the PR moves by a task-file-only commit on top: the gate stays open and the desk still shows it as MERGE"
    - kind: "automated"
      check: "(unit) the hold check fails with a git error: the gate stays open"
    - kind: "automated"
      check: "(unit) when the new head's gate opens, the desk shows one MERGE item with the new gate id; a review-blocked park whose gate was closed offers no dipo approve --note"
    - kind: "automated"
      check: "(unit, cli) dipo desk prints the same items office.desk returns for the moved PR"
    - kind: "manual"
      check: "On the scratch repository, let a story reach a merge gate that waits for the maintainer, then push a code commit to its branch"
      expect: "The desk drops the MERGE item for that story at once; it comes back with the new gate after the new head's review and checks pass"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 When dipo records a new head for a story PR, every open merge gate of the run that does not hold for it by AutoMerge.gateHolds (the check gate.approve uses) closes as superseded with the new head in its note
- [ ] #2 A gate that still holds (its own head, or a task-file-only commit on top) stays open and shows as MERGE with dipo approve and dipo reject
- [ ] #3 The desk offers no MERGE item and no dipo approve --note for a closed gate; when the new head's gate opens, the MERGE item shows with it
- [ ] #4 A failed hold check leaves the gate open, and gate.approve still refuses a gate that does not hold
- [ ] #5 dipo desk and the TUI show the same items, both from office.desk
<!-- AC:END -->
