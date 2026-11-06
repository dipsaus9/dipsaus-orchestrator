---
id: DIPO-455
title: >-
  Give planning sessions an interviewing standard, my project preferences and
  question dialogs
status: Refined
assignee: []
created_date: '2026-11-06 09:37'
updated_date: '2026-11-06 09:38'
labels:
  - 'tier:M'
milestone: m-3
dependencies:
  - DIPO-447
  - DIPO-448
  - DIPO-449
references:
  - packages/engine/src/prompts/
  - packages/contract/src/
  - packages/tui/src/
  - docs/decisions/0022-planning-sessions.md
priority: medium
type: feature
ordinal: 428000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want every planning session to interview me by a fixed standard, know my project preferences and ask its questions as dialogs I answer with keys, so that planning in dipo works like the planning chats I do today.

M3 (0022, maintainer's answers 2026-11-06). Needs DIPO-447 (the session), DIPO-448 (the decision record) and DIPO-449 (the TUI view).

The standard is part of dipo's planning prompt, the same in every office, beside the other prompts (packages/engine/src/prompts/): ask, never assume; each question stands on its own, with its purpose before its options and the recommended option, if any, first; explain further when an option is unclear; back every claim about the code with file and line; write stories that lead with who, what and why (0012); propose nothing outside the maintainer's goals. The office file `.dipo/planning.md`, kept in the repository and edited by the maintainer, adds the project's standing preferences; the session's first message holds it when it exists.

Questions come in a structured block the engine validates (schema in packages/contract): at most four questions, each with a short header, its purpose, two to four options with a description each, at most one marked recommended, and always room for a free answer. An invalid block goes back to Claude once with its problems. The TUI shows a valid block as a dialog the maintainer answers with keys, with a free answer per question; the answers go back as one message, and each confirmed choice enters the decision record (DIPO-448).

Built by dipo where it can (maintainer's choice, 2026-11-05); a builder agent takes over if dipo gets stuck.

```dipo
branch: "DIPO-455/planning-interview-standard"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the planning prompt holds each rule of the interviewing standard, and the first message holds the office planning file when it exists and nothing when it does not"
    - kind: "automated"
      check: "(unit) the question block schema accepts one to four questions with header, purpose, two to four described options and at most one recommended, and refuses each other shape"
    - kind: "automated"
      check: "(unit) an invalid block is sent back once with its problems; the answers to a valid block go back as one message and enter the decision record"
    - kind: "automated"
      check: "(unit) TUI test: a question block renders as a dialog, keys pick an option or open a free answer, and send returns the answers"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 dipo's planning prompt holds the interviewing standard: ask, never assume; each question with its purpose before its options and the recommended option, if any, first; explain further when an option is unclear; claims about the code backed by file and line; stories that lead with who, what and why; nothing outside the maintainer's goals
- [ ] #2 The session's first message holds the office's .dipo/planning.md when it exists
- [ ] #3 Claude asks in a question block the engine validates: one to four questions, each with a header, its purpose, two to four options with a description each, at most one recommended, and room for a free answer
- [ ] #4 An invalid question block is sent back to Claude once with its problems
- [ ] #5 The TUI shows a question block as a dialog answered with keys, including a free answer, and sends the answers as one message that enters the decision record
- [ ] #6 ADR 0022 still describes what runs
<!-- AC:END -->
