---
id: DIPO-502
title: The Ready gate keeps a design or docs story to its kind's area
status: In Review
assignee: []
created_date: '2026-11-13 12:58'
updated_date: '2026-11-16 15:05'
labels:
  - 'tier:S'
  - 'role:developer'
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

R24 is a placeholder: it fails every story whose role label names a non-code role (packages/engine/src/gate/rules.ts:556-567). DIPO-500 gave each roster role a kind (code, design or docs): a role file without kind is a code role (packages/engine/src/roles/parse.ts:24), and the gate's roster carries it as GateRole.kind (packages/engine/src/gate/types.ts:96-100, filled in packages/engine/src/roles/base.ts:21). The maintainer decided (planning 2026-11-13) which paths each kind may write:
- design: only under docs/design/<ID>/, the story's own folder (0012 section 4).
- docs: Markdown files under docs/ outside docs/decisions/ and docs/design/, and Markdown files at the repository root, such as README.md.
- code: any path, as today.

Scope:
- A new module, packages/engine/src/roles/area.ts, answers whether a path is in a kind's area for a story id. A folder reference (ending in /) is in the docs area when it is under docs/ and outside docs/decisions/ and docs/design/, and in the design area when it is docs/design/<ID>/ or a folder under it. The later part-scan story (DIPO-503) uses the same module, so the gate and the run agree.
- R24: a story whose role label names a design or docs role fails for each reference outside its kind's area. Each failure names the reference and the kind's area. A code role or a story without a role label passes R24.
- Inputs are unchanged: a design story may read inputs anywhere, and R25 still checks design inputs.

Amend 0012: the R24 row and section 4 describe the design and docs areas.

```dipo
branch: "DIPO-502/ready-gate-keeps-design-docs-story-its"
unknowns:
  - q: "Blocked on the ADR-citation rule: may code comments and test titles say 'section 4' of 0012 when they describe the R24 areas, or should they cite only the ADR number? I will drop the section reference and fix the citation test failure once you confirm. Shard 2's DIPO-401 failure also needs a look: is it known-flaky?"
    status: "resolved"
    answer: "Cite the ADR by number only (CLAUDE.md: never by section): drop 'section 4' from comments and test titles and fix the citation test. For the DIPO-401 failure in shard 2: run it once more; if it passes it is flaky and you go on, if it fails again check whether your change causes it and fix it, and park only if it is unrelated to this story."
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
- [x] #1 A design story whose references are all under docs/design/<ID>/ passes R24.
- [x] #2 A design story with a reference outside docs/design/<ID>/ fails R24, and the failure names that reference and the area.
- [x] #3 A docs story whose references are Markdown files under docs/ outside docs/decisions/ and docs/design/, or Markdown files at the repository root, passes R24.
- [x] #4 A docs story with a reference under docs/decisions/, under docs/design/, to a file that is not Markdown, or to a Markdown file in a folder outside docs/, fails R24 for that reference.
- [x] #5 A story with a code role, or without a role label, passes R24 whatever its references are.
- [x] #6 Decision 0012 describes the design and docs areas in the R24 row and in section 4.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parked 2026-11-16 14:59 UTC: ambiguous-spec
- Detail: Blocked on the ADR-citation rule: may code comments and test titles say 'section 4' of 0012 when they describe the R24 areas, or should they cite only the ADR number? I will drop the section referenc…
- Run: run_01M7JDFCHARV1YBW2KZAAAMZH4
- Criteria met: 0 of 6 (as the worker reported them)
- Loops: 0 of 3; CI attempts: 0 of 2
- Review rounds: 0, failed 0 of 3
- Budget used: 111,682 of 300,000 tokens; 21 of 90 turns; 7 of 45 minutes
- Last good commit: ce963b8a4d4b046007f202dc0315cc305d8887f4

Resumed 2026-11-16 15:01 UTC; grants: none; note: Cite the ADR by number only (CLAUDE.md: never by section): drop 'section 4' from comments and test titles and fix the citation test. For the DIPO-401 failure in shard 2: run it once more; if it passe…
<!-- SECTION:NOTES:END -->
