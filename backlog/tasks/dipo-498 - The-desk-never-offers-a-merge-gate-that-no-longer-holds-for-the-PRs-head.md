---
id: DIPO-498
title: The desk never offers a merge gate that no longer holds for the PR's head
status: In Progress
assignee: []
created_date: '2026-11-13 10:20'
updated_date: '2026-11-13 10:56'
labels:
  - 'tier:M'
milestone: m-3
dependencies: []
references:
  - packages/engine/src/overview/desk.ts
  - packages/engine/src/merge/commands.ts
  - packages/engine/src/merge/merger.ts
  - packages/engine/src/merge/stories.ts
  - packages/engine/src/story-pr/prs.ts
  - packages/engine/src/create/commands.ts
  - packages/engine/src/worktree/done.ts
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
- The desk lists every open merge gate that waits on the maintainer (`#openMergeGates`, packages/engine/src/overview/desk.ts:672-682) and offers `dipo approve` on each (`#mergeGate` desk.ts:702-731; the review-blocked park row's `dipo approve --note` desk.ts:784-797), without asking whether the gate still holds for the PR's head.
- `gate.approve` and `gate.reject` refuse such a gate (`#forPrHead`, packages/engine/src/merge/commands.ts:240-255) through `holds`, which is `AutoMerge.gateHolds` (packages/engine/src/merge/merger.ts:154-163) and `StoryMerges.gateHolds` (packages/engine/src/merge/stories.ts:624-639): its own head, or a head whose code tree has the gate head's verdict (a task-file-only commit on top).
- `gateHolds` cannot tell a failed read from "does not hold": `#verdictFor` (packages/engine/src/merge/stories.ts:571-585) swallows a `treeKey` error and falls back, and `#holds` (merge/stories.ts:588-606) then answers false. Approve may refuse on that; a close may not, because a closed gate never comes back.
- A gate that stops holding is never closed when the PR moves. Open gates of a run close as superseded only when a new gate opens (`#openGate`, packages/engine/src/merge/stories.ts:704-756), which happens when the new head has a passed verdict and its checks (`#gateFor` merge/stories.ts:641-673 from `#approvedGate` merge/stories.ts:406-432), on a foreign head (merge/stories.ts:938-943) or on a wait label (merge/stories.ts:1007-1010). Until then the stale gate stays open for the whole build and review of the new head, and forever when that never comes (the run parks or ends).

The fix, one rule in one place:
- `StoryMerges` (packages/engine/src/merge/stories.ts) gets one hold answer with three outcomes: holds, does not hold, unknown. It is "does not hold" only when the code tree keys of both the gate's head and the new head were read and differ; "unknown" when either read failed. `gateHolds` for approve and reject is that answer with unknown as false, so approve refuses as it does today. No second rule.
- Close on a moved head: when dipo records a new head for a story PR, every open merge gate of the run whose answer is "does not hold" closes as superseded, decided `rejected` by `rule` with the note "superseded: the PR head moved to <short head>", the way `#openGate` closes them. Override gates (`overrideOf` set) are skipped, as `#openGate` skips them (merge/stories.ts:733): `#overrideGates` (merge/stories.ts:782-805) never reopens one, so closing it would take `dipo approve --note` off the PARKED row for good. On "unknown" the gate stays open and dipo logs the failed read with the gate, run and heads.
- Wiring: the check reaches `StoryPrs` (packages/engine/src/story-pr/prs.ts) as an injected dependency, the way `MergeGatesDeps.holds` reaches the gate commands (merge/ already imports story-pr/, so story-pr/ must not import merge/), wired in packages/engine/src/create/commands.ts next to `holds`. The async check runs before the synchronous `#write`, and the closes are written in the same `#write` as the new head.
- The places that write a new head (`updateStoryPr`): the sync after a push (prs.ts:895-920) and a closed PR found open again at a new head (prs.ts:818-830) both close stale gates. Left out: the merged record (prs.ts:955-970 and packages/engine/src/worktree/done.ts:86-100), because a merged PR is not a head under review: its run ends and its open gates are the sweep's below.
- One sweep at daemon start, under the same rule: for every open merge gate of the office that is no override gate, compare its head with its run's story PR head; "does not hold" closes it as above, "unknown" leaves it and logs. This closes the gates already stale today in parked and ended runs, such as DIPO-489's.

The desk keeps listing the open gates as it does, so it never offers a gate approve would refuse. The story then shows nothing for that gate: its run is on the floor in build or review (0009), or on its PARKED row. When the new head's gate opens, the MERGE item shows with that gate.

Replaces: the stale merge gate left open from the PR's move until a later gate opens (the `#openGate` close stays for gates that still hold).

Not a guard: what merges does not change; `gate.approve` and `gate.reject` already refuse a gate that does not hold and keep doing so (R30 does not apply). ADRs need no line: 0002 and 0020 already say the desk lists the gates that wait for the maintainer, and a gate for an old head no longer waits for anyone.

Tier M: one hold answer split out of an existing check, an injected dependency into StoryPrs, one close at two head writes and a start sweep, and their tests.

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
      check: "(unit, story-pr sync) a closed PR found open again at a new code head closes the stale gate the same way"
    - kind: "automated"
      check: "(unit) the tree key read fails on the move: the gate stays open and the failed read is logged; then git recovers, and the gate still holds for the head and merges once approved"
    - kind: "automated"
      check: "(unit) a review-blocked park's override gate stays open when its PR moves, and the PARKED row still offers dipo approve --note"
    - kind: "automated"
      check: "(unit) the start sweep closes a stale gate of a parked run and of an ended run, keeps a holding gate and an override gate, and leaves a gate whose read fails"
    - kind: "automated"
      check: "(unit) when the new head's gate opens, the desk shows one MERGE item with the new gate id"
    - kind: "automated"
      check: "(unit, cli) dipo desk prints the same items office.desk returns for the moved PR"
    - kind: "manual"
      check: "On the scratch repository, let a story reach a merge gate that waits for the maintainer, then push a code commit to its branch"
      expect: "The desk drops the MERGE item for that story at once; it comes back with the new gate after the new head's review and checks pass"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 StoryMerges has one hold answer (holds, does not hold, unknown): does not hold only when both heads' code tree keys were read and differ; gateHolds for approve and reject is that answer with unknown as false
- [ ] #2 When dipo records a new head for a story PR (the sync after a push and a reopened PR), every open non-override merge gate of the run that does not hold for it closes as superseded with the new head in its note; the check is injected into StoryPrs and runs before its #write
- [ ] #3 A gate that still holds (its own head, or a task-file-only commit on top) stays open and shows as MERGE with dipo approve and dipo reject
- [ ] #4 An unknown answer leaves the gate open and logs the failed read; once git recovers the gate still holds and merges
- [ ] #5 Override gates never close on a moved head, and the PARKED row keeps dipo approve --note
- [ ] #6 At daemon start one sweep closes the open non-override merge gates that do not hold for their run's PR head, under the same rule
- [ ] #7 The desk offers no MERGE item for a closed gate; when the new head's gate opens the MERGE item shows with it; dipo desk and the TUI show the same items from office.desk
<!-- AC:END -->
