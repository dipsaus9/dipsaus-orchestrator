---
id: DIPO-504
title: The worker contract gets a section for the run's kind
status: Ready
assignee: []
created_date: '2026-11-13 13:29'
updated_date: '2026-11-13 15:03'
labels:
  - 'tier:M'
milestone: m-4
dependencies:
  - DIPO-477
  - DIPO-502
  - DIPO-503
references:
  - packages/engine/src/prompts/contract/implement-box.md
  - packages/engine/src/prompts/contract/kind/code.md
  - packages/engine/src/prompts/contract/kind/design.md
  - packages/engine/src/prompts/contract/kind/docs.md
  - packages/engine/src/prompts/system.ts
  - packages/engine/src/prompts/templates.ts
  - packages/engine/src/prompts/contract.ts
  - packages/engine/src/roles/area.ts
  - packages/engine/src/run/prompts.ts
  - packages/engine/src/run/resume.ts
  - packages/engine/test/prompts/system.test.ts
  - packages/engine/test/prompts/golden
  - docs/decisions/0014-worker-prompt-assembly.md
type: feature
ordinal: 475000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want a designer or a docs writer to get a contract that asks for their kind of work so that they are not told to deliver code and tests.

The implement-box contract speaks to a developer: its first line says the worker is a developer, and What to deliver asks for code and tests and says dipo runs the verify at done (packages/engine/src/prompts/contract/implement-box.md:3, 5-7). renderSystemFile joins one contract and one role (packages/engine/src/prompts/system.ts:14). DIPO-477 makes it take the run's stored role text, and DIPO-503 stores the role's kind with the run. The maintainer decided (planning 2026-11-13) on one contract with a kind section.

- Contract: implement-box.md keeps everything every kind shares. Its first line no longer names a developer. What to deliver moves into one section per kind under packages/engine/src/prompts/contract/kind/: code.md says what the contract says today; design.md asks for design documents in the story's area and says dipo checks each part against it and does not run the verify at done; docs.md says the same for Markdown docs.
- renderSystemFile takes the kind and puts its section after the contract and before the role text. The system file is still byte-identical for the same kind and role text, and still holds no id, date, path or count (0014; system.test.ts:40-45).
- Task message: a design or docs run gets an area section that names, in paths, where it may write for this story, from the area module of DIPO-502 (packages/engine/src/roles/area.ts). The tag goes into PROMPT_TAGS (packages/engine/src/prompts/templates.ts:176), and the kind section refers to it. A code run gets no area section.
- A code run, and a run started before DIPO-503 without a stored kind, gets the code section. Every later session of a run (resume, fix round, hand-off) uses the run's stored kind.
- Golden files: system-implement-box-developer.md is updated, and one golden file per kind is added.

The reviewer, planner, auditor and scanner contracts are unchanged. Amend 0014: L1 is the shared contract plus the run kind's section, and the task message has the area section.

```dipo
branch: "DIPO-504/worker-contract-gets-section-run-s-kind"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "The code-kind system file matches its golden file and holds the code section between the contract and the role"
    - kind: "automated"
      check: "The design-kind and docs-kind system files match their golden files and hold no id, date, path or count"
    - kind: "automated"
      check: "A design run's task message for DIPO-9 has an area section naming docs/design/DIPO-9/, and a code run's has none"
    - kind: "automated"
      check: "A resumed run with no stored kind renders the code-kind system file"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The system file of a code run holds the shared contract, the code section with what What to deliver says today, and then the role text.
- [ ] #2 The system file of a design run holds the shared contract, the design section and then the role text, and says nothing about code, tests or a verify at done.
- [ ] #3 The system file of a docs run holds the shared contract, the docs section and then the role text.
- [ ] #4 For each kind the system file is byte-identical for the same role text and holds no id, date, path or count.
- [ ] #5 The task message of a design or docs run has an area section that names the paths the run may write for its story; a code run's task message has none.
- [ ] #6 A run without a stored kind gets the code section in its first session and every later one.
- [ ] #7 Decision 0014 says L1 is the shared contract plus the run kind's section, and describes the area section.
<!-- AC:END -->
