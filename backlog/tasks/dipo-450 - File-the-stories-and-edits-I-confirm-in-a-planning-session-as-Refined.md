---
id: DIPO-450
title: File the stories and edits I confirm in a planning session as Refined
status: Done
assignee: []
created_date: '2026-11-05 20:51'
updated_date: '2026-11-06 14:33'
labels:
  - 'tier:L'
milestone: m-3
dependencies:
  - DIPO-447
  - DIPO-449
references:
  - packages/contract/src/office.ts
  - packages/engine/src/workers/claude-cli/report-schema.ts
  - packages/engine/src/backlog/lane/ops.ts
  - packages/engine/src/backlog/lane/lane.ts
  - packages/engine/src/story-store/planning.ts
  - packages/engine/src/backlog/runner.ts
  - packages/tui/src/
  - docs/decisions/0010-backlog-and-git-integration.md
modified_files:
  - docs/decisions/0010-backlog-and-git-integration.md
  - docs/how-dipo-works.md
  - packages/contract/schema/commands.schema.json
  - packages/contract/schema/events.schema.json
  - packages/contract/schema/reads.schema.json
  - packages/contract/schema/work.schema.json
  - packages/contract/src/office.ts
  - packages/contract/src/work.test.ts
  - packages/contract/src/work.ts
  - packages/contract/test/fixtures.ts
  - packages/engine/src/backlog/lane/feature.ts
  - packages/engine/src/backlog/lane/index.ts
  - packages/engine/src/backlog/lane/lane.ts
  - packages/engine/src/backlog/lane/planning.ts
  - packages/engine/src/backlog/lane/stories.ts
  - packages/engine/src/create/commands.ts
  - packages/engine/src/create/compose.ts
  - packages/engine/src/create/runs.ts
  - packages/engine/src/db/migrations/0004-planning-record.ts
  - packages/engine/src/db/schema.ts
  - packages/engine/src/prompts/contract/planning-box.md
  - packages/engine/src/prompts/task/planning.md
  - packages/engine/src/prompts/templates.ts
  - packages/engine/src/records/planning-record.ts
  - packages/engine/src/retention/policy.ts
  - packages/engine/src/retention/run.ts
  - packages/engine/src/run/planning-proposals.ts
  - packages/engine/src/run/planning-session.ts
  - packages/engine/src/story-store/planning.ts
  - packages/engine/src/workers/claude-cli/report-schema.ts
  - packages/engine/src/workers/port.ts
  - packages/engine/src/workers/types.ts
  - packages/engine/test/db/migrations.test.ts
  - packages/engine/test/prompts/task.test.ts
  - packages/engine/test/run/adapter.test.ts
  - packages/engine/test/run/planning-filing.test.ts
  - packages/engine/test/run/planning-proposals.test.ts
  - packages/engine/test/run/planning-session.test.ts
  - packages/engine/test/run/planning-world.ts
  - packages/tui/src/planning.test.tsx
  - packages/tui/src/planning.tsx
  - packages/tui/src/proposal-form.test.ts
  - packages/tui/src/proposal-form.ts
  - packages/tui/test/support/harness.ts
priority: high
type: feature
ordinal: 423000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want each story I confirm in a planning session filed as Refined with a proposed tier and its reason, and each edit I confirm applied to the existing story, so that planning ends in real stories without hand work.

M3 (0022). Needs DIPO-447 and DIPO-449 (proposals are shown in the planning view).

Claude proposes a story or an edit in a structured block: a schema in packages/contract that the engine validates (given to the session the way the reviewer's report schema is, packages/engine/src/workers/claude-cli/report-schema.ts). The planning view shows each proposal with its proposed tier and one line of why, and confirm, edit and decline; these reach the engine as commands. On confirm, code files it through the planning lane (packages/engine/src/backlog/lane/lane.ts), which opens or updates dipo's backlog PR. Missing today: creating a task and editing its title, description, criteria and references through the lane (the edit kind sets only status, field-block keys and labels, packages/engine/src/backlog/lane/ops.ts). Filed ids go into the session's record (DIPO-448).

Built by dipo where it can (maintainer's choice, 2026-11-05); a builder agent takes over if dipo gets stuck.

```dipo
branch: "DIPO-450/file-confirmed-stories"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a proposal that fails the schema is refused with a message; a valid one is shown with its tier and reason"
    - kind: "automated"
      check: "(unit) a confirmed proposal is filed Refined through the lane to the story standard with its tier label, and its id goes into the session's record"
    - kind: "automated"
      check: "(unit) a confirmed edit changes the story's title, description, criteria or references through the lane; a split files the new story and edits the old one; a decline files nothing"
    - kind: "manual"
      check: "On the scratch repository, plan a small feature in a planning session and confirm two stories"
      expect: "Two Refined stories land on main through dipo's backlog PR with no hand step"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Claude's proposals use a schema in the contract that the engine validates, and an invalid proposal is refused with a message
- [x] #2 A proposal is shown in the planning view with its proposed tier and one line of why, and confirm, edit and decline reach the engine as commands
- [x] #3 A confirmed story is filed Refined to the story standard through the planning lane, and its id is stored in the session's record
- [x] #4 A confirmed edit changes an existing story's title, description, criteria or references through the planning lane, and a confirmed split files the new story and edits the old one
- [x] #5 ADR 0010 describes creating and editing stories through the lane, with one Replaced line
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-06 14:33 UTC
- Criteria met: 5 of 5 (as the worker reported them)
- Loops: 1; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 2, failed 0
- Budget used: 582,851 of 2,000,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 3
<!-- SECTION:FINAL_SUMMARY:END -->
