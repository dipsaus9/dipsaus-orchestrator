---
id: DIPO-912
title: >-
  Queue: a now view of what can start and a plan view of every open story by milestone
status: Draft
assignee: []
created_date: '2026-11-28 11:00'
labels:
  - 'tier:M'
  - 'role:developer'
milestone: m-6
dependencies:
  - DIPO-900
references:
  - packages/tui/src/queue.tsx
  - packages/tui/src/keys.ts
  - packages/contract/src/office.ts
  - packages/engine/src/overview/chain.ts
  - docs/design/chat-and-activity/screens/10-queue-now.txt
  - docs/design/chat-and-activity/screens/11-queue-plan.txt
  - docs/design/chat-and-activity/spec.md
  - docs/design/chat-and-activity/keymap-additions.json
  - docs/design/tui-v2/screens/05-queue.txt
priority: high
type: feature
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want the Queue to show me at once what can start now, and on a second view every open story by milestone with its progress and what blocks it, so that I can pick the next story quickly and plan the milestones from the same room.

P8 of chat-and-activity spec.md. The arrow keys switch `now` and `plan`, shown at the right of the rooms row like Retro's period; the Queue opens on now and remembers the choice. now (10-queue-now.txt) lists only Ready stories whose dependencies are Done, in next-up order, with the slots and one line counting what it leaves out. plan (11-queue-plan.txt) groups every story that is not Done by milestone in the backlog's order: a head with a Done bar and done/total, open stories in chain order with 05-queue.txt's row, a finished milestone folded to one line, more than four stories folded behind `+ N more`, stories without a milestone last. Enter folds a head and opens a story. A milestone's preview shows its description, progress, Ready, why the rest is not Ready, the next story to act on, its chain and what blocks it. A new read office.milestones carries all of it; the TUI groups and counts nothing. keymap.json gains queueView and milestoneFold from keymap-additions.json.

```dipo
branch: "DIPO-912/queue-now-and-plan"
unknowns:
  - q: "Should the Queue keep today's three-group view (05-queue.txt) as a third view, or does plan replace it?"
    status: "open"
test_plan:
  entries:
    - kind: "automated"
      check: "(integration) 10-queue-now.txt and 11-queue-plan.txt pass expectScreen whole"
    - kind: "automated"
      check: "(unit) office.milestones returns each milestone's counts, open stories in chain order and its chain"
    - kind: "automated"
      check: "(unit) now lists a Ready story with a dependency not Done under neither CAN START NOW nor the count of Ready"
    - kind: "automated"
      check: "(unit) the arrow keys switch the view and the choice survives a restart"
    - kind: "automated"
      check: "(unit) Enter on a milestone head folds and unfolds it, and a milestone with more than four open stories folds the rest"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The arrow keys switch the Queue between now and plan, shown on the rooms row; the choice is remembered
- [ ] #2 now lists only stories that can start, in next-up order, with the slots and a count of what it leaves out
- [ ] #3 plan groups every open story by milestone in the backlog's order with a progress bar, chain order and folding
- [ ] #4 A milestone's preview shows description, progress, Ready, why the rest waits, the next story, its chain and blocker
- [ ] #5 The engine's new read office.milestones carries every number and order the views show
- [ ] #6 Both screens pass expectScreen and keymap.json carries the two new keys
<!-- AC:END -->
