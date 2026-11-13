---
id: DIPO-496
title: Every Refined story says whether it passes the gate and how to make it Ready
status: Refined
assignee: []
created_date: '2026-11-13 09:17'
updated_date: '2026-11-13 09:30'
labels:
  - 'tier:M'
milestone: m-3
dependencies:
  - DIPO-497
references:
  - packages/tui/src/queue.tsx
  - packages/tui/src/queue.test.tsx
  - packages/engine/src/views/story.ts
  - packages/engine/src/gate/hash.ts
  - packages/engine/src/overview/desk.ts
  - packages/contract/src/office.ts
  - packages/cli/src/desk-command.ts
  - packages/cli/src/desk-command.test.ts
  - docs/decisions/0009-tui.md
  - docs/decisions/0020-park-and-resume.md
priority: high
type: feature
ordinal: 467000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want every Refined story to tell me whether it would pass the Ready gate and, in words, how to make it Ready, so that I never have to work out how a story gets to Ready.

M3 (0022), a feature from the maintainer on 2026-11-13: "It also takes too much of an effort to make a story ready. It also is unclear how to do this."

What already shows (DIPO-482, Done): a Refined row in the Queue reads `gate passes` or the first failed rule (packages/tui/src/queue.tsx:68-71, :97-100), from the engine's latest stored decision (`latestGate`, packages/engine/src/views/story.ts:195-215, used at :242-254); the Queue's preview shows the live `story.gate` result (queue.tsx:221-245); `space` marks a row and `Y` sets the marked ones Ready (0009 section 4). DIPO-483 (Done) shows each desk item's full text and is not about Ready. DIPO-495 makes a planning confirm file a passing story Ready and puts the gate's messages on the card of one that stayed Refined, so the planning card is not part of this story.

What is missing, and what this story adds (reads only, no new status logic):
1. The row says the step. A passing Refined row reads `gate passes · space Y to set Ready`; a failing one keeps the first failure and adds the rule's fix where the gate gives one. The Queue preview of a Refined story (the story's detail for a Refined story; packages/tui/src/detail.tsx is the running story's view) ends with one line naming the next step: `space` then `Y` here, or `dipo ready <ID>`, when it passes; the failing rules to fix when it does not.
2. A stale pass never shows. `latestGate` takes the latest decision whatever content it was made for. The row and the desk count use a decision only when its content hash is the story's current one (`gateContentHash`, packages/engine/src/gate/hash.ts); a Refined story without one reads `gate not checked yet` and the preview's live `story.gate` tells.
3. The desk says it once. When N > 0 Refined stories have a passing decision for their current content, the desk shows one item `READY TO SET`: "N stories Refined but passing the gate: space and Y in the Queue (3)", with the stories' ids and the command `dipo ready <ID>...`. It goes when N is 0. The kind joins `KNOWN_DESK_KINDS` (packages/contract/src/office.ts:996-1016) after `NEXT UP`, and the engine's desk (packages/engine/src/overview/desk.ts) builds it from the story views; `dipo desk` prints it as any item.

Replaces: the stale-pass read of `latestGate` for the Queue row. Nothing else is replaced; the item is new and has no older mechanism.

Needs DIPO-497: both edit ADR 0009 section 3 and the planning end's "how to set it Ready later" line names the same step this story words, so this story follows it.

Not a guard: it reads gate decisions and changes no rule, no deny rule and no permission (R30 does not apply). Who may set Ready is unchanged.

ADR lines that change: 0009 section 3, the **Queue** line (line 45) gains the row's step and the preview's next-step line; the **Desk** line (line 48) stays; 0020's desk order (the kinds in contract order, line 119) gains `READY TO SET` after next up.

Tier M: one desk item through contract and engine, the Queue row and preview, and the stale-decision rule.

```dipo
branch: "DIPO-496/refined-says-how-to-ready"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit, queue) a passing Refined row reads 'gate passes · space Y to set Ready'; a failing row keeps its first failure; the preview's last line names space then Y or dipo ready <ID> when it passes and the failing rules when it does not"
    - kind: "automated"
      check: "(unit, views/story) a passing decision for older content is not a pass: the row reads 'gate not checked yet'; a decision for the current content hash is used"
    - kind: "automated"
      check: "(unit, overview/desk) with two Refined stories passing for their current content the desk has one READY TO SET item naming both ids and dipo ready; with none it has no such item; the item comes after NEXT UP"
    - kind: "automated"
      check: "(unit, cli) dipo desk prints the READY TO SET item with its command line"
    - kind: "manual"
      check: "On the scratch repository, with one Refined story that passes and one that fails, open the Desk, then the Queue"
      expect: "The Desk shows one READY TO SET item naming the passing story; the Queue rows say how to set it Ready and what to fix on the other"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A passing Refined row in the Queue reads gate passes with the key to set it Ready, a failing row keeps its first failure, and the preview of a Refined story ends with one line naming the next step
- [ ] #2 A gate decision counts for a Refined story only when its content hash is the story's current one; without one the row reads gate not checked yet
- [ ] #3 When Refined stories pass for their current content the desk shows one READY TO SET item with their count, ids and dipo ready command, after NEXT UP, and none when there are none
- [ ] #4 dipo desk prints the READY TO SET item with its command line
- [ ] #5 ADR 0009's Queue line and ADR 0020's desk order describe the row's step and the new item
<!-- AC:END -->
