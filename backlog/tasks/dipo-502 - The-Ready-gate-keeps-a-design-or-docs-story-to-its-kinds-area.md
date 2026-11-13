---
id: DIPO-502
title: The Ready gate keeps a design or docs story to its kind's area
status: Ready
assignee: []
created_date: '2026-11-13 12:58'
updated_date: '2026-11-13 13:14'
labels:
  - 'tier:S'
milestone: m-4
dependencies:
  - DIPO-500
references:
  - packages/engine/src/roles/area.ts
  - packages/engine/src/gate/rules.ts
  - packages/engine/src/gate/types.ts
  - packages/engine/test/gate/gate.test.ts
  - packages/engine/test/gate/fixtures.ts
  - docs/decisions/0012-story-standard.md
type: feature
ordinal: 473000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want the Ready gate to refuse a design or docs story whose references reach outside the files its role may write so that a story that its run would park for leaving its area never gets Ready.

R24 is a placeholder: it fails every story whose role label names a non-code role (packages/engine/src/gate/rules.ts:550-561). DIPO-500 gives each roster role a kind (code, design or docs). The maintainer decided (planning 2026-11-13) which paths each kind may write:
- design: only under docs/design/<ID>/, the story's own folder (0012 section 4).
- docs: Markdown files under docs/ outside docs/decisions/ and docs/design/, and Markdown files at the repository root, such as README.md.
- code: any path, as today.

Scope:
- A new module, packages/engine/src/roles/area.ts, answers whether a path is in a kind's area for a story id. A folder reference (ending in /) is in the docs area when it is under docs/ and outside docs/decisions/ and docs/design/, and in the design area when it is docs/design/<ID>/ or a folder under it. The later part-scan story uses the same module, so the gate and the run agree.
- R24: a story whose role label names a design or docs role fails for each reference outside its kind's area. Each failure names the reference and the kind's area. A code role or a story without a role label passes R24.
- Inputs are unchanged: a design story may read inputs anywhere, and R25 still checks design inputs.

Amend 0012: the R24 row and section 4 describe the design and docs areas.

```dipo
branch: "DIPO-502/ready-gate-keeps-design-docs-story-its"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "The area module puts docs/design/DIPO-9/a.md in the design area of DIPO-9 and not of DIPO-8, and puts README.md and docs/guide/x.md in the docs area but not docs/decisions/0001.md, docs/design/x/a.md or packages/a.md"
    - kind: "automated"
      check: "R24 passes a design story with only docs/design/<ID>/ references and fails one with packages/x.ts, naming that reference"
    - kind: "automated"
      check: "R24 passes a docs story with README.md and docs/guide/ and fails one with docs/decisions/0001-x.md, naming that reference"
    - kind: "automated"
      check: "R24 passes a code-role story and a story without a role label whatever their references"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A design story whose references are all under docs/design/<ID>/ passes R24.
- [ ] #2 A design story with a reference outside docs/design/<ID>/ fails R24, and the failure names that reference and the area.
- [ ] #3 A docs story whose references are Markdown files under docs/ outside docs/decisions/ and docs/design/, or Markdown files at the repository root, passes R24.
- [ ] #4 A docs story with a reference under docs/decisions/, under docs/design/, to a file that is not Markdown, or to a Markdown file in a folder outside docs/, fails R24 for that reference.
- [ ] #5 A story with a code role, or without a role label, passes R24 whatever its references are.
- [ ] #6 Decision 0012 describes the design and docs areas in the R24 row and in section 4.
<!-- AC:END -->
