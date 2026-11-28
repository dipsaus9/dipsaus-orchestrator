---
id: DIPO-523
title: >-
  Chat: one standing conversation per office, in threads, instead of sessions to
  start and end
status: Ready
assignee: []
created_date: '2026-11-28 14:11'
updated_date: '2026-11-28 18:14'
labels:
  - 'tier:L'
  - 'role:developer'
milestone: m-5
dependencies:
  - DIPO-522
references:
  - packages/engine/src/run/planning.ts
  - packages/engine/src/run/planning-session.ts
  - packages/engine/src/db/migrations/0012-planning-messages.ts
  - packages/contract/src/work.ts
  - packages/contract/src/office.ts
  - docs/design/chat-and-activity/migration.md
priority: high
type: feature
ordinal: 484000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want to just write to dipo, whenever, and have it remember, so that I never start or end a session or hear that another one is open.

P2. `chat.message { office, thread?, text, context }` sends to the open thread or opens one titled by the message; `/new` opens one, `/end` closes it with today's Ready step, a day idle closes it. The planning record becomes the thread record; an open planning session migrates to an open thread with its goal as title. One Claude session answers per office; a message sent meanwhile is held and sent after (`queued · sends when the answer ends`). planning.start, planning.message and planning.end stay for one release as aliases. Split before Ready if it does not fit: threads and chat.message first, the queue and the aliases second.

Design: docs/design/chat-and-activity/ (spec.md, P2; screens/02-chat-room.txt head lines; screens/07-states.txt C5 queued input and closed thread). The mocks win; a cell difference is a bug (DIPO-520).

```dipo
branch: "DIPO-523/standing-chat-threads"
unknowns:
  - q: "How open planning sessions migrate"
    status: "resolved"
    answer: "An open planning session becomes an open thread titled by its goal, with its record (decisions, filed stories, messages) kept; the next message continues it and /end runs its Ready step (maintainer, planning session of 2026-11-28)."
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) chat.message with no open thread opens one titled by the message"
    - kind: "automated"
      check: "(unit) a message sent while an answer streams is held and sent when it ends"
    - kind: "automated"
      check: "(unit) a thread idle a day closes and keeps its record"
    - kind: "automated"
      check: "(unit) planning.start and planning.end map to /new and /end"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Each office has one standing chat and chat.message never fails with planning.open
- [ ] #2 A thread has a title, decisions, filed stories and messages, stored as the planning record is today
- [ ] #3 /end runs today's Ready step and closes the thread; a day idle closes it
- [ ] #4 One Claude session answers per office; a message sent meanwhile is held and sent after
- [ ] #5 The planning commands keep working for one release as aliases
<!-- AC:END -->
