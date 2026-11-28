---
id: DIPO-525
title: 'Chat: steer, answer, resume, ready and command cards that I confirm'
status: In Review
assignee: []
created_date: '2026-11-28 14:11'
updated_date: '2026-11-28 19:51'
labels:
  - 'tier:M'
  - 'role:developer'
milestone: m-5
dependencies:
  - DIPO-523
references:
  - packages/engine/src/run/planning-proposals.ts
  - packages/contract/src/office.ts
  - packages/tui/src/actions.ts
  - docs/design/chat-and-activity/screens/05-run-with-dock-wide.txt
  - docs/design/chat-and-activity/screens/01-queue-with-dock.txt
  - docs/design/chat-and-activity/screens/07-states.txt
priority: medium
type: feature
ordinal: 486000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want dipo's advice to come with the action ready to send, so that steering a looping run or answering a worker is one key after I've read it, and still my decision.

P4. Cards are blocks in an answer, validated by the engine like proposals (an invalid one is refused with a message to Claude): steer, answer, resume, ready, command. Drawn as 07-plan.txt cards: `◆ <kind> · <target> · <consequence>`, the text dim indented 5, the keys acc. `c` sends work.steer, work.answer, work.resume or story.ready as the maintainer with origin chat; a command card's `c` copies its line and `X` opens the existing drop prompt. Results show in place as 07-states.txt C5.

Design: docs/design/chat-and-activity/ (spec.md, P4; screens/05-run-with-dock-wide.txt (steer card), 01-queue-with-dock.txt (command card), 07-states.txt (card results)). The mocks win; a cell difference is a bug (DIPO-520).

```dipo
branch: "DIPO-525/chat-action-cards"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a steer card for a story that is not running is refused with a message to Claude"
    - kind: "automated"
      check: "(unit) c on a steer card sends work.steer with origin chat and the card shows sent"
    - kind: "automated"
      check: "(unit) a card that would drop or discard can only be a command card"
    - kind: "automated"
      check: "(integration) 05-run-with-dock-wide.txt and the C5 card captions pass expectScreen"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The contract defines the five cards and the engine validates them against the office's state
- [x] #2 c sends the matching command as the maintainer with origin chat; nothing runs without it
- [x] #3 A card shows pending, sent or failed in place, with ^R to retry
- [x] #4 Drop and discard appear only as command cards or open the existing prompts
- [x] #5 The screens named above pass expectScreen
<!-- AC:END -->
