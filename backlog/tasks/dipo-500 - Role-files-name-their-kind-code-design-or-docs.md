---
id: DIPO-500
title: 'Role files name their kind: code, design or docs'
status: Refined
assignee: []
created_date: '2026-11-13 12:49'
updated_date: '2026-11-13 12:49'
labels:
  - 'tier:M'
milestone: m-4
dependencies:
  - DIPO-471
  - DIPO-473
references:
  - packages/engine/src/roles/parse.ts
  - packages/engine/src/roles/base.ts
  - packages/engine/src/roles/view.ts
  - packages/engine/src/gate/types.ts
  - packages/contract/src/office.ts
  - packages/contract/schema/reads.schema.json
  - packages/tui/src/roles.tsx
  - docs/decisions/0017-testing-strategy-and-configuration.md
  - docs/decisions/0001-foundational-decisions.md
type: feature
ordinal: 471000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want a role file to say whether its role writes code, designs or docs so that the engine can treat a designer or a docs writer differently from a developer.

A role file accepts only version, purpose, model and effort, and an unknown key is refused (packages/engine/src/roles/parse.ts:18-25). Every file role is a code role: rosterOf maps each one to code: true (packages/engine/src/roles/base.ts:20-22), and the gate's GateRole has only a code flag (packages/engine/src/gate/types.ts:93-97). The maintainer decided (planning 2026-11-13) that a role file names its kind with a key whose values the engine defines, and that M4 defines three kinds: code, design and docs.

- Role file: a new optional frontmatter key, kind, with the values code, design and docs. A file without it is a code role, so the seeded developer.md is unchanged. Any other value refuses the file with a message that names the file, the key and the three values, as other key problems do (issueText, parse.ts:47-53).
- Role: gains kind, always set after parsing.
- Roster: GateRole gains kind, and rosterOf sets code from kind === 'code' and passes the kind on. R24 is unchanged in this story: a later story gives it each kind's area.
- Contract: RoleView (packages/contract/src/office.ts:1171) gains kind, and office.roles returns it. The schema files in packages/contract/schema are regenerated.
- TUI: the Roles room shows each role's kind next to its model and effort (modelLine, packages/tui/src/roles.tsx:134).

Which paths each kind may write, the part-scan check, skipping verify and the contract's kind section are later stories. Role proposals setting the kind are a separate story that waits on DIPO-474. Amend 0017 for the kind key and 0001 Roles for the three kinds.

```dipo
branch: "DIPO-500/role-files-name-their-kind-code-design"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "parseRoleFile loads kind design and kind docs with that kind, loads a file without kind as code, and refuses kind writer with a message naming the file, the key and the three values"
    - kind: "automated"
      check: "rosterOf gives code false and the kind for design and docs roles, and code true for a code role"
    - kind: "automated"
      check: "office.roles returns the kind of each role loaded from the base"
    - kind: "automated"
      check: "The Roles room renders each role's kind beside its model and effort"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A role file with kind: design or kind: docs loads with that kind.
- [ ] #2 A role file without a kind key loads as a code role.
- [ ] #3 A role file with any other kind value is refused, and its problem names the file, the key and the values code, design and docs.
- [ ] #4 The gate's roster marks a design or docs role as not code and a code role as code, and carries each role's kind.
- [ ] #5 office.roles returns each role's kind.
- [ ] #6 The Roles room shows each role's kind beside its model and effort.
- [ ] #7 Decision 0017 describes the kind key and its three values, and 0001 Roles names the three kinds.
<!-- AC:END -->
