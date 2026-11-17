---
id: DIPO-507
title: Answering a parked story's question from the desk sends its question id
status: Done
assignee: []
created_date: '2026-11-13 13:02'
updated_date: '2026-11-17 10:54'
labels:
  - tech-debt
  - 'tier:S'
  - 'role:developer'
milestone: m-3
dependencies: []
references:
  - packages/engine/src/overview/desk.ts
  - packages/tui/src/home.tsx
  - packages/engine/test/overview/desk.test.ts
modified_files:
  - packages/engine/src/overview/desk.ts
  - packages/engine/test/overview/desk.test.ts
type: bug
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want to answer a parked story's question from the TUI desk so that I can unblock the story without an Invalid args error and without falling back to the command line.

The desk's PARKED row adds one work.answer action per open question on the park (packages/engine/src/overview/desk.ts:785-787), but the item it builds (desk.ts:808-825) never sets its question field. The QUESTION row does (desk.ts:671). The TUI reads the answer's question id only from that field (packages/tui/src/home.tsx:120 in deskTarget, then packages/tui/src/actions.ts:419), so answering a parked question with a or r sends work.answer with no question, and argument checking rejects it with 'client.failed: Invalid args for work.answer'. The command line in the action is fine, because it carries the id itself.

The TUI already handles a correct row: its fixture askedPark (packages/tui/src/desk.test.tsx:77-90) sets question, and the test at desk.test.tsx:682 sends work.answer with it. That fixture just has a field the engine never sends. The fix is in the engine: set question on the PARKED and PARKED BY YOU item to the id of the park's oldest open question. openParkQuestions returns them oldest first (packages/engine/src/run-state/questions.ts:109-118), so that is the question of the row's first work.answer action, the one the TUI picks (home.tsx:804). No contract change: DeskItem.question is already optional (packages/contract/src/office.ts:1056).

```dipo
branch: "DIPO-507/answering-parked-story-s-question-from"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "The desk test 'puts a question park's question on its PARKED row' in packages/engine/test/overview/desk.test.ts also expects the item's question to be qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1B."
    - kind: "automated"
      check: "A desk test with a park carrying two open questions expects the PARKED item's question to be the older one, matching its first work.answer action."
    - kind: "automated"
      check: "A desk test with an open park and no question expects the PARKED item to have no question field."
    - kind: "manual"
      check: "Park a story with an open worker question, select its PARKED row on the TUI desk, press a, type an answer and send it."
      expect: "The answer is accepted with no client.failed message, and the question closes on the desk."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A PARKED or PARKED BY YOU desk item whose park carries at least one open question has its question field set to the id of the park's oldest open question.
- [x] #2 That question id is the same id as in the item's first work.answer action command line.
- [x] #3 A PARKED desk item whose park carries no open question has no question field.
- [ ] #4 Answering a parked question from the TUI desk with a or r sends work.answer with the question id and the typed text, and the engine accepts it.
- [x] #5 The QUESTION desk item and its work.answer action are unchanged.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-17 10:54 UTC
- Criteria met: 4 of 5 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 1, failed 0
- Budget used: 36,990 of 300,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 0
<!-- SECTION:FINAL_SUMMARY:END -->
