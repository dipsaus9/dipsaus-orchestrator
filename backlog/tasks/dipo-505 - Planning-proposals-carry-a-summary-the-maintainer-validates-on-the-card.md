---
id: DIPO-505
title: Planning proposals carry a summary the maintainer validates on the card
status: Refined
assignee: []
created_date: '2026-11-13 13:31'
updated_date: '2026-11-13 15:06'
labels:
  - 'tier:M'
  - 'role:developer'
milestone: m-3
dependencies:
  - DIPO-476
  - DIPO-497
references:
  - packages/contract/src/work.ts
  - packages/contract/schema/work.schema.json
  - packages/engine/src/run/planning-proposals.ts
  - packages/engine/src/run/planning-session.ts
  - packages/engine/src/story-store/planning.ts
  - packages/engine/src/prompts/contract/planning-box.md
  - packages/engine/test/run/planning-proposals.test.ts
  - packages/engine/test/run/planning-filing.test.ts
  - packages/tui/src/planning.tsx
  - packages/tui/src/planning.test.tsx
  - packages/tui/src/proposal-form.ts
  - packages/tui/src/proposal-form.test.ts
  - docs/decisions/0022-planning-sessions.md
  - docs/decisions/0012-story-standard.md
type: feature
ordinal: 476000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want each story proposal to state what it leaves out, every decision line it changes and its risks, shown on its card and written into the story, so that my confirm validates the story's content and not only its form.

Today a card shows only the title, the tier and the Story line, or the why for an edit (proposalHead and firstLine, packages/tui/src/planning.tsx:761-792; card rows at 858-881). The proposal schema has no field for what a story leaves out, the decision lines it changes or its risks (storyShape and editShape, packages/contract/src/work.ts:554-628). The Ready gate checks form, never quality (0012 line 7), and DIPO-495 files a confirmed story Ready, so the maintainer's confirm is the only check on content. The maintainer decided (planning 2026-11-13): the planner writes the summary, a review session checks it (a later story, refining DRAFT-16), it is shown on the card and written into the filed story.

Contract:
- A required summary on the story, split, refine and edit proposals: notDoing (a list of one-line statements of what the story does not do), adrLines (a list, each with the decision file under docs/decisions/, its section, the quote of the current text or none for a new line, and what it becomes) and risks (a list, each with a kind, guard-loosened, spend, tier or other, and one line). Each list may be empty, so the planner says none on purpose. The Story line stays the what, for whom and why. The schema files in packages/contract/schema are regenerated.

Engine:
- A code check, after the schema, at each turn end (packages/engine/src/run/planning-session.ts:1451) and on planning.edit (:1048): each quote must appear word for word within one line of its file at the base branch's tip, and the file must be under docs/decisions/. A miss is refused like a schema problem, naming the file and the section.
- Filing: for a story, the new story of a split and a refined draft, the lane writes the summary below the context as three fixed sections, What it does not do, ADR lines that change and Risks and choices (storyDescription, packages/engine/src/story-store/planning.ts:355, used at planning-proposals.ts:236). An edit's summary shows only on the card; an edit that replaces the context replaces those sections with it, as context is replaced today.
- The planning contract (packages/engine/src/prompts/contract/planning-box.md) says what each summary field asks for.

TUI:
- The focused card shows the Story line, then the three parts with each ADR line as file, section, quote and what it becomes. Every other card shows its head, its Story line and one count line, such as 2 not doing, 3 ADR lines, 1 risk.
- The edit form (packages/tui/src/proposal-form.ts) carries the summary.

DIPO-476 and DIPO-497 change the same schema and card code, so this story comes after them. ADR lines that change: 0022 section 2, line 24, "A new story is filed to the story standard (0012), with a proposed tier and one line of why" becomes "...with a proposed tier, one line of why and its summary", and a new line, Summary, describes the three parts. 0012 F3, line 15, "One Story: line in the description; technical context goes below it" becomes "...technical context, then the planning summary's sections, go below it".

```dipo
branch: "DIPO-505/planning-proposals-carry-summary"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "The schema refuses a story, split, refine and edit proposal without a summary and accepts one whose three lists are empty"
    - kind: "automated"
      check: "A quote found within one line of a decision file at the base passes; a quote changed by one character, and a file outside docs/decisions/, are refused with the file and section named"
    - kind: "automated"
      check: "planning.edit with a quote not in its file is refused with the same problem"
    - kind: "automated"
      check: "A confirmed story, a split's new story and a refined draft are filed with the three summary sections below the context; a confirmed edit's summary is not written"
    - kind: "automated"
      check: "The focused card renders the Story line, the not-doing lines, each ADR line with quote and new text, and each risk with its kind; an unfocused card renders the head, Story line and count line"
    - kind: "automated"
      check: "The proposal form round-trips a summary unchanged"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A story, split, refine or edit proposal without a summary is refused, and one whose three lists are empty passes.
- [ ] #2 A summary quote that is not word for word within one line of its decision file at the base's tip is refused, and the problem names the file and the section.
- [ ] #3 An adrLines entry whose file is not under docs/decisions/ is refused.
- [ ] #4 The maintainer's edit of a proposal gets the same quote check.
- [ ] #5 A filed story, the new story of a split and a refined draft hold the three summary sections below their context.
- [ ] #6 A confirmed edit does not write its summary into the story.
- [ ] #7 The focused card shows the Story line, what it does not do, each ADR line with its quote and what it becomes, and the risks with their kinds.
- [ ] #8 Every other card shows its head, its Story line and one count line of the three parts.
- [ ] #9 The edit form opens and sends the summary unchanged when the maintainer does not touch it.
- [ ] #10 Decision 0022 line 24 and a new Summary line, and 0012 F3, describe the summary as the context of this story says.
<!-- AC:END -->
