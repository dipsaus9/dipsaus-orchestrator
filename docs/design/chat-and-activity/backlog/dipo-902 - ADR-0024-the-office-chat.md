---
id: DIPO-902
title: >-
  Decide in ADR 0024 that each office has one standing chat in threads, led by context
status: Draft
assignee: []
created_date: '2026-11-28 10:00'
labels:
  - 'tier:S'
  - 'role:developer'
milestone: m-5
dependencies: []
references:
  - docs/decisions/0024-office-chat.md
  - docs/decisions/0022-planning-sessions.md
  - docs/decisions/0003-milestones-and-quality-bar.md
  - docs/decisions/0009-tui.md
  - docs/design/chat-and-activity/spec.md
  - docs/design/chat-and-activity/migration.md
priority: high
type: spike
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: We need to decide how the chat works once it is dipo's voice in every room instead of a planning session so that every later chat story follows one set of rules on threads, context and the actions it may offer.

The chat shifts from planning only to dipo's voice in the office (spec.md, What the chat is for). It is the M5 conversation layer of 0003 and vision.md: it maps the maintainer's words to commands and asks for confirmation, and it can never do something no command can; 0024 says so and 0003's M5 line points to it. Proposals P1 to P4 of spec.md. 0024 keeps 0022's box, model, interviewing standard, decision record and one-Claude-session rule, and changes: begin and end become threads (`/new`, `/end`, a day idle closes one); kind becomes context (room and focused item, facts built by code); the chat may add steer, answer, resume, ready and command cards that run only as the maintainer's command on `c`, with origin chat, never drop or discard. 0022 is rewritten where it changes and gets one Replaced line (CLAUDE.md: ADRs describe what runs). This needs the maintainer's explicit approval (CLAUDE.md, Rules).

Design: docs/design/chat-and-activity/ (spec.md, Proposals P1 to P4; migration.md, The ADR change). The mocks win; a cell difference is a bug (DIPO-900).

```dipo
branch: "DIPO-902/adr-0024-office-chat"
unknowns:
  - q: "Is the ADR number 0024 free?"
    status: "resolved"
    answer: "Yes on origin/main ebde2136: the last ADR is 0023-skills-and-plugins.md (DIPO-519). Take the next free number if another lands first."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 0024 opens with the chat's purpose as spec.md "What the chat is for" states it: explain, help decide, help fix, plan, improve the process; never act, never a second dashboard, never a replacement for keys, never a guess
- [ ] #2 docs/decisions/0024-office-chat.md decides one standing chat per office in threads, closed by /end or a day idle
- [ ] #3 It replaces the session kind with context and lists the facts code builds per room; it decides the five action cards, their confirm and origin chat, and that drop and discard are never cards that run
- [ ] #4 0022 is rewritten where it changed and has its Replaced line; the maintainer approved the decision
- [ ] #5 docs/decisions/0003-milestones-and-quality-bar.md names the chat as the M5 conversation layer and points to 0024
<!-- AC:END -->
