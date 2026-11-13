---
id: DIPO-501
title: Role proposals can set a role's kind
status: Ready
assignee: []
created_date: '2026-11-13 12:58'
updated_date: '2026-11-13 15:06'
labels:
  - 'tier:S'
  - 'role:developer'
milestone: m-4
dependencies:
  - DIPO-474
  - DIPO-500
references:
  - packages/contract/src/work.ts
  - packages/contract/schema
  - packages/engine/src/run/planning-proposals.ts
  - packages/engine/src/backlog/lane
  - packages/tui/src/planning.tsx
  - docs/decisions/0022-planning-sessions.md
type: feature
ordinal: 472000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want a session's role proposals to set a role's kind so that I can add a designer or a docs writer from the roles chat, not only developers.

DIPO-474 adds the role, role-edit and role-remove proposals, which write .dipo/roles/<name>.md through the planning lane, with a name, a purpose, optional model and effort, and the instructions. DIPO-500 adds the role file's kind key (code, design or docs; a file without it is a code role). Until both meet, a proposal cannot make a non-code role.

- Contract: the role proposal and the role-edit proposal (packages/contract/src/work.ts) gain an optional kind with the values code, design and docs. The schema files in packages/contract/schema are regenerated, so a session's first message carries the new field.
- Role: a role proposal with a kind writes the kind key into the new file. Without a kind it writes none, so the file is a code role, as today.
- Role-edit: a kind rewrites only the kind key and keeps the rest of the file, as DIPO-474's edit does for its other fields.
- The check DIPO-474 runs on the file a role or role-edit produces (the role-file parser) also covers the kind, so a bad value is refused as any other problem is.
- The planning view shows a role proposal's kind with its other fields.

Amend 0022 where it describes the role proposals.

```dipo
branch: "DIPO-501/role-proposals-can-set-role-s-kind"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "A confirmed role proposal with kind design writes a role file that parseRoleFile loads with kind design"
    - kind: "automated"
      check: "A confirmed role proposal without a kind writes a file with no kind key"
    - kind: "automated"
      check: "A role-edit with only kind docs rewrites the kind key and keeps every other field of the file byte for byte"
    - kind: "automated"
      check: "A role proposal with kind writer is refused with a problem naming code, design and docs"
    - kind: "automated"
      check: "The planning view renders a role proposal's kind"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A role proposal with kind design files a role file that loads as a design role.
- [ ] #2 A role proposal without a kind files a role file without a kind key, which loads as a code role.
- [ ] #3 A role-edit proposal that gives only a kind changes the kind key and leaves the purpose, model, effort and instructions as they were.
- [ ] #4 A role or role-edit proposal with a kind other than code, design or docs is refused, and the problem names the three values.
- [ ] #5 The planning view shows the kind of a role proposal.
- [ ] #6 Decision 0022 says a role or role-edit proposal may set the kind.
<!-- AC:END -->
