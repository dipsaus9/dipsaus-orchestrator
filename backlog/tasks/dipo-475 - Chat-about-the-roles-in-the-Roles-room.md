---
id: DIPO-475
title: Chat about the roles in the Roles room
status: Done
assignee: []
created_date: '2026-11-10 15:05'
updated_date: '2026-11-13 13:43'
labels:
  - 'tier:M'
milestone: m-4
dependencies:
  - DIPO-471
  - DIPO-473
  - DIPO-474
  - DIPO-476
references:
  - packages/contract/src/work.ts
  - packages/engine/src/run/planning-session.ts
  - packages/engine/src/run/planning-proposals.ts
  - packages/engine/src/prompts/task/planning.md
  - packages/engine/src/prompts/templates.ts
  - packages/engine/src/records/retro.ts
  - packages/tui/src/roles.tsx
  - packages/tui/src/planning.tsx
  - docs/decisions/0022-planning-sessions.md
modified_files:
  - docs/decisions/0022-planning-sessions.md
  - packages/contract/schema/commands.schema.json
  - packages/contract/schema/events.schema.json
  - packages/contract/schema/reads.schema.json
  - packages/contract/schema/work.schema.json
  - packages/contract/src/work.ts
  - packages/engine/src/prompts/task/planning-roles.md
  - packages/engine/src/prompts/templates.ts
  - packages/engine/src/records/retro.ts
  - packages/engine/src/run/planning-proposals.ts
  - packages/engine/src/run/planning-session.ts
  - packages/engine/test/prompts/task.test.ts
  - packages/engine/test/run/planning-roles-session.test.ts
  - packages/engine/test/run/planning-roles.test.ts
  - packages/tui/src/app.tsx
  - packages/tui/src/keys.ts
  - packages/tui/src/mode.ts
  - packages/tui/src/planning.test.tsx
  - packages/tui/src/planning.tsx
  - packages/tui/src/roles.test.tsx
  - packages/tui/src/roles.tsx
  - packages/tui/src/screen.tsx
type: feature
ordinal: 448000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want to talk through my roles with a planner in the Roles room, with each role's recent runs in view, so that I can hire, tune and retire roles based on how they did.

The maintainer decided (planning 2026-11-10) that the Roles room holds a chat, that the chat may add, edit and remove roles, and that it reads the role files plus each role's recent runs.

Session:
- A new planning kind, roles (PLANNING_KINDS, packages/contract/src/work.ts:408), on the same session machinery (packages/engine/src/run/planning-session.ts). It shares the office's one planning slot: starting it while a session is open is refused as planning.open (planning-session.ts:698) is.
- It runs with the planner role and the planning-box contract, read-only as every planning session is.
- A roles session accepts only the role, role-edit and role-remove proposals (DIPO-474) and refuses story proposals. The other kinds refuse role proposals. Its first message carries only the schema of the role proposals.

First message (packages/engine/src/prompts/task/planning.md; new tags go into PROMPT_TAGS, packages/engine/src/prompts/templates.ts:176):
- The goal.
- Each roster role: name, purpose, model, effort and instructions.
- Each invalid role file with its problem.
- Each role's recent runs, counted by code from the state database as the retro is (packages/engine/src/records/retro.ts): how they ended, parks by reason, review rounds failed, CI attempts and cost. They come from runs joined to run_outcomes by the run's role. Runs from before runs followed the role label count as developer.
- The role proposal schema and the question schema.

TUI:
- In the Roles room (DIPO-473), a key starts the chat with a typed goal. The chat shows beside the list, with the planning view's message, question, proposal and confirm handling (packages/tui/src/planning.tsx).
- The planning view's kind cycle does not offer roles.
- After a confirmed change merges, the list shows the new roster, through the roster refresh of the Roles room story.

Amend 0022 for the roles kind and its first message.

```dipo
branch: "DIPO-475/chat-about-roles-roles-room"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "The first message of a roles session on an office with two roles, one invalid file and runs of both roles holds each role, the invalid file and each role's run counts."
    - kind: "automated"
      check: "The run counts per role match a state database fixture with runs of two roles and different outcomes and parks."
    - kind: "automated"
      check: "A roles session refuses a story proposal block, and a plan session refuses a role proposal block, each with a problem naming the kind."
    - kind: "automated"
      check: "planning.start of kind roles while a plan session is open is refused as planning.open."
    - kind: "automated"
      check: "The Roles room renders the chat beside the list after the start key, and a confirmed role proposal sends the confirm command."
    - kind: "manual"
      check: "In the Roles room, start a chat asking to add a tester role, confirm the proposal and wait for the backlog PR to merge."
      expect: "The proposal shows with its name and purpose, the backlog PR adds .dipo/roles/tester.md, and the list shows the tester role after the merge."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Starting a roles session from the Roles room opens a planning session of kind roles, and starting one while another planning session is open is refused.
- [x] #2 The first message of a roles session holds every roster role with its purpose, model, effort and instructions, and every invalid role file with its problem.
- [x] #3 The first message holds, per role, its recent runs: how they ended, parks by reason, review rounds failed, CI attempts and cost, counted from the state database.
- [x] #4 A roles session refuses a story proposal, and a plan, refine or triage session refuses a role proposal.
- [x] #5 The Roles room shows the chat beside the list, with questions, proposals and confirm working as in the planning view.
- [x] #6 The planning view's kind choice does not offer roles.
- [x] #7 Decision 0022 describes the roles kind, what its first message holds and which proposals it takes.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-13 13:43 UTC
- Criteria met: 7 of 7 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 1, failed 0
- Budget used: 194,212 of 800,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 0
<!-- SECTION:FINAL_SUMMARY:END -->
