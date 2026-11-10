---
id: DIPO-483
title: The desk shows every item's full text
status: Refined
assignee: []
created_date: '2026-11-10 15:36'
updated_date: '2026-11-10 15:50'
labels:
  - 'tier:S'
milestone: m-6
dependencies: []
references:
  - packages/engine/src/overview/desk.ts
  - packages/contract/src/office.ts
  - packages/tui/src/desk-preview.ts
  - packages/tui/src/desk.tsx
  - packages/cli/src/desk-command.ts
  - packages/engine/src/workers/claude-cli/result.ts
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/src/records/summary.ts
priority: high
type: bug
ordinal: 455000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want every desk item's question, note and park detail shown whole on the Desk and in dipo desk, so that I can read what a worker asks me and answer it without opening the database or the task file.

M6 (TUI v2), a bug from the maintainer's use on 2026-11-10: they could not read a park question on the Desk. Examples: DIPO-461's park question and DIPO-470's park detail both end in "…" on the Desk and in `dipo desk`.

Where the text is cut (on main):
- The engine cuts every desk item's `detail` and `hand` to `DESK_DETAIL_MAX` (300) characters and one line before any client sees it: `deskLine` in packages/engine/src/overview/desk.ts:371-374, applied at :554-555, with the cut at :381-390. So the TUI preview, `dipo desk` and `dipo desk --json` all get the cut text.
- The TUI cuts again for the list row (packages/tui/src/desk.tsx:420-426, `truncate`), which is right for a row of the list.
- The park block in the task's notes keeps only the first line, cut at `SUMMARY_TEXT_MAX` (`oneLine`, packages/engine/src/records/summary.ts:50-60, used by `renderParkBlock` at :149-154). That block is a summary and stays as it is; the full question is in the story's unknowns.

The fix: desk items carry the full cleaned text (still `cleanDoorText`, worker text is data, 0008) beside the one-line form the list row uses. The desk preview shows it whole, wrapped at the pane width and scrollable, never cut (0009 already says "wrapped and never cut"); `dipo desk` prints it whole under the item, and `--json` carries it whole. One mechanism (0001): the one-line cut stays only for the list row; the full text replaces the 300-character cut everywhere else.

DIPO-470's park detail also holds a raw tool-call fragment: the worker's report `summary` ended in `</summary>\n<parameter name="question">` and then the question, with no `question` field, and the park detail took the summary (packages/engine/src/workers/claude-cli/result.ts:147, `report.question ?? report.summary`). The worker adapter (Claude specifics stay there, CLAUDE.md) splits such a report: the text after a `<parameter name="question">` fragment is the question, the text before it the summary, and no tag text reaches the park, the desk or the task.

```dipo
branch: "DIPO-483/desk-full-text"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a desk item whose detail is 2,000 characters over several lines reaches office.desk whole and cleaned, with its one-line row form beside it"
    - kind: "automated"
      check: "(unit) the desk preview renders that detail whole, wrapped at 80 and 120 columns with no cut and no ellipsis, and scrolls when it is taller than the pane"
    - kind: "automated"
      check: "(unit) dipo desk prints the full detail under the item, and dipo desk --json carries it whole"
    - kind: "automated"
      check: "(unit) a blocked report whose summary holds </summary> and <parameter name=\"question\"> with no question field parks with the question as its detail and no tag text; a report with a question field is unchanged"
    - kind: "manual"
      check: "On the scratch repository, park a story with a long question and open it on the Desk and with dipo desk"
      expect: "The whole question shows in the preview and in dipo desk, with no ellipsis and no tag text"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 office.desk carries each item's full cleaned detail and hand text beside the one-line row form; the 300-character cut is gone outside the list row
- [ ] #2 The desk preview shows the full text wrapped at the pane width, scrollable when taller than the pane, never cut
- [ ] #3 dipo desk prints each item's full text, and dipo desk --json carries it whole
- [ ] #4 A worker report whose summary holds a raw question parameter fragment and no question field parks with the question taken from after the fragment, and no tag text reaches the park, the desk or the task
<!-- AC:END -->
