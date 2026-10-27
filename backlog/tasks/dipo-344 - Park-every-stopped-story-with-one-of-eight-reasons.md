---
id: DIPO-344
title: Park every stopped story with one of eight reasons
status: Refined
assignee: []
created_date: '2026-10-25 09:51'
updated_date: '2026-10-27 16:52'
labels:
  - 'tier:L'
  - 'slice:prune'
  - 'track:1'
milestone: m-1
dependencies: []
references:
  - packages/contract/src/
  - packages/engine/src/run/
  - packages/engine/src/stories/
  - packages/engine/src/hooks/
  - packages/engine/src/workers/
  - packages/engine/src/views/
  - packages/engine/src/db/
  - packages/cli/src/
  - packages/tui/src/
priority: high
type: feature
ordinal: 324000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo park replaces stop, hold and pause, a stopped story is Parked with one of the eight reasons of 0001 and a text detail.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. Maintainer decisions of 2026-10-24 (audit questions 3 and 10; 0020). Absorbs DIPO-326 and replaces the closed DIPO-338. Starts paused and plan-limit resume moved to DIPO-359, one source for status and park reason to DIPO-360.

```dipo
branch: "DIPO-344/one-park-eight-reasons"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) each of the eight reasons resumes, or is refused, as the 0020 table says"
    - kind: "automated"
      check: "(db) the migration maps every old reason and cause to one of the eight reasons"
    - kind: "manual"
      check: "On a scratch repo, dipo park a running story, then dipo resume it"
      expect: "it parks by-maintainer and a new session continues in the same box"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 dipo park ID --note parks a Refined, Ready, In Progress or In Review story as by-maintainer, stopping a running worker first; work.stop, work.pause, story.hold, their CLI commands and their TUI keys are removed
- [ ] #2 The park reasons are the eight of 0001, the park causes and the resume matrix are removed, and the detail is text that no code branches on
- [ ] #3 dipo resume follows the table in 0020: an answer for ambiguous-spec, a note or approve --note for review-blocked, --budget and --note for budget-exceeded, refused for scope-violation, nothing more for the rest
- [ ] #4 Parks stored with a removed reason or cause are migrated to the new reasons, and every way a park is resolved closes its open questions with a question.closed event
<!-- AC:END -->
