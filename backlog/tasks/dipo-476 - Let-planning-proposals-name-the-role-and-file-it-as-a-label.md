---
id: DIPO-476
title: Let planning proposals name the role and file it as a label
status: Refined
assignee: []
created_date: '2026-11-10 15:05'
updated_date: '2026-11-12 13:57'
labels:
  - 'tier:M'
milestone: m-4
dependencies:
  - DIPO-471
  - DIPO-472
  - DIPO-474
references:
  - packages/contract/src/work.ts
  - packages/engine/src/backlog/lane/stories.ts
  - packages/engine/src/run/planning-session.ts
  - packages/engine/src/prompts/task/planning.md
  - packages/engine/src/prompts/contract/planning-box.md
  - packages/engine/src/prompts/templates.ts
  - packages/tui/src/planning.tsx
type: feature
ordinal: 449000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want each story the planner proposes to name a role from my roster, filed as its role label, so that new stories pass the gate and run as the role they were planned for.

Today the engine files a story with only its tier label: fileKind passes --labels tier:<tier> (packages/engine/src/backlog/lane/stories.ts:199-200), refineCalls adds only tier:<tier> (stories.ts:380, 394), and checkFiled checks only the tier (stories.ts:156). The proposal schema has a tier and no role (packages/contract/src/work.ts:557). The maintainer decided (planning 2026-11-10) that a role label becomes required and that the proposal names it.

- The story proposal, the story of a split and the refine proposal get a required role: a role name (RoleId, packages/contract/src/ids.ts:39). An edit proposal does not change labels; DIPO-478 adds that.
- The engine checks the role against the office's roster (DIPO-471) when it validates a proposal block. A role not in the roster is refused like any schema problem, and the problem lists the roster's role names.
- The lane's file and refine targets carry the role. A filed story gets role:<role> next to tier:<tier>, a refined draft gets it added, and checkFiled refuses a story that reads back without it.
- The planner's first message gets a roles section with each roster role's name and purpose (packages/engine/src/prompts/task/planning.md; its tag goes into PROMPT_TAGS, packages/engine/src/prompts/templates.ts:176). The planning contract (prompts/contract/planning-box.md) says to pick one of them.
- The TUI shows the role next to the tier: proposalHead (packages/tui/src/planning.tsx:735) gives the title and tier to the proposal line (planning.tsx:812-813) and to the Ready step's names (planning.tsx:288-291).

Drafts made by the idea audit are unchanged: a draft becomes a story only through a refine proposal, which names the role.

```dipo
branch: "DIPO-476/let-planning-proposals-name-role-file-it"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "The proposal schema refuses a story, split or refine proposal without a role, and accepts one with a role name."
    - kind: "automated"
      check: "Validating a proposal against a roster without its role refuses it, and the problem lists the roster's names."
    - kind: "automated"
      check: "Applying a file target on a temporary backlog files the story with tier and role labels; applying a refine target adds the role label to the promoted task."
    - kind: "automated"
      check: "The planning first message rendered for a roster of two roles holds both names and purposes in its roles section."
    - kind: "automated"
      check: "The TUI planning view renders the role on a story proposal line."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The story, split and refine proposal schemas require a role, and a block without one is refused with a problem naming the missing role.
- [ ] #2 A proposal whose role is not in the office's roster is refused, and the problem lists the roster's role names.
- [ ] #3 A confirmed story proposal is filed with the labels tier:<tier> and role:<role>.
- [ ] #4 A confirmed refine proposal promotes the draft to a story labelled tier:<tier> and role:<role>.
- [ ] #5 Filing refuses a story that reads back without the proposed role label.
- [ ] #6 The planner's first message holds a roles section with each roster role's name and purpose.
- [ ] #7 The TUI shows the proposed role on each story, split and refine proposal line.
<!-- AC:END -->
