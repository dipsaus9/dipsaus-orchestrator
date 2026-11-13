---
id: DIPO-471
title: Load role files from the base and build the roster from them
status: Done
assignee: []
created_date: '2026-11-10 14:35'
updated_date: '2026-11-13 10:08'
labels:
  - 'tier:M'
milestone: m-4
dependencies: []
references:
  - packages/engine/src/roles/
  - packages/engine/src/gate/types.ts
  - packages/engine/src/gate/evaluate.ts
  - packages/engine/src/gate/index.ts
  - packages/engine/src/gate-decisions/feature.ts
  - packages/engine/src/gate-decisions/read.ts
  - packages/engine/src/office/manager.ts
  - scripts/check-ready-gate.ts
  - docs/decisions/0017-testing-strategy-and-configuration.md
  - docs/decisions/0012-story-standard.md
  - docs/decisions/0014-worker-prompt-assembly.md
  - docs/decisions/0001-foundational-decisions.md
modified_files:
  - docs/decisions/0001-foundational-decisions.md
  - docs/decisions/0004-language-and-runtime.md
  - docs/decisions/0012-story-standard.md
  - docs/decisions/0014-worker-prompt-assembly.md
  - docs/decisions/0017-testing-strategy-and-configuration.md
  - packages/engine/src/gate-decisions/feature.ts
  - packages/engine/src/gate/evaluate.ts
  - packages/engine/src/gate/index.ts
  - packages/engine/src/gate/types.ts
  - packages/engine/src/office/manager.ts
  - packages/engine/src/roles/base.ts
  - packages/engine/src/roles/parse.ts
  - packages/engine/test/engine/loop-office.ts
  - packages/engine/test/gate/gate.test.ts
  - packages/engine/test/gate/gated-office.ts
  - packages/engine/test/gate/index-notify.ci.test.ts
  - packages/engine/test/gate/story-gate.ci.test.ts
  - packages/engine/test/gate/story-gate.test.ts
  - packages/engine/test/office/roles.test.ts
  - packages/engine/test/roles/parse.test.ts
  - packages/engine/test/run/run-office.ts
  - packages/engine/test/run/work-run.ci.test.ts
  - scripts/check-ready-gate.test.ts
  - scripts/check-ready-gate.ts
  - tools/lint/oxlint-plugin.js
type: feature
ordinal: 444000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want the roles of an office to be files in its repository, each with its instructions, a purpose and an optional model and effort, so that I can add and tune roles through a reviewed change and the Ready gate knows which roles exist.

Today the roster is the constant BUILT_IN_ROSTER with only developer (packages/engine/src/gate/types.ts:100). Neither gate caller passes a roster: the daemon (packages/engine/src/gate-decisions/feature.ts:177) and the CI script (scripts/check-ready-gate.ts:94). So R17 (packages/engine/src/gate/rules.ts:440) refuses every role label but developer.

The file shape is fixed by 0017 section 5: .dipo/roles/<name>.md, YAML frontmatter plus instructions. The maintainer decided the first cut's keys (planning 2026-11-10):
- version: required integer, 1 (0017 section 7);
- purpose: required, one line;
- model, effort: optional, overriding the tier's for this role (vision section 5). They are read here and used by a later story.
The frontmatter is a strict schema, as in 0017 section 6: an unknown key is an error naming the file, the key path and that the key may need a newer dipo. Allowed tools are left out, because the adapter names the tools per kind (0008, 2026-10-29). There is no code or non-code key yet: non-code roles come later in M4.

The role name is the file name without .md and must match RoleId (packages/contract/src/ids.ts:39). The names reviewer, planner, auditor and scanner are reserved: they stay engine code (maintainer decision, 2026-11-10), and a file with one of them is an error. The instructions are the Markdown body after the frontmatter, and an empty body is an error.

The files are read at the base commit from git's objects, never the checkout, as .dipo/office.yaml is (packages/engine/src/office/manager.ts:145). They are read again when they change on the base, through the same poll (manager.ts:491). An invalid role file leaves only that role out of the roster and raises one notice naming the file and the problem. The other roles and the office's runs are unaffected. The CI script reads the roles of the checked-out commit, as it reads its config.

The gate stays pure: the roster arrives in GateInput.roster, and each file role is a code role (code true). BUILT_IN_ROSTER goes away, because one mechanism per goal applies. An office with no role files has an empty roster. A story with no role label still passes R17, which allows at most one role. Runs still use the bundled developer instructions until a later story.

Amend the decisions to the new shape:
- 0017 section 5: the role file format and its keys;
- 0012 F12: the roster now comes from role files;
- 0014 section 1, the L2 row: the role file;
- 0001 Roles: drop the until-M4 sentence for the roster.
The module's place in the engine bands follows the layer lint rules.

```dipo
branch: "DIPO-471/load-role-files-from-base-build-roster"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "Parsing a valid role file gives its name, purpose, instructions, model and effort; one without model and effort gives neither."
    - kind: "automated"
      check: "Parsing refuses an unknown key, a missing version, a missing purpose, an empty body, a reserved name and an invalid file name, each with a message naming the file."
    - kind: "automated"
      check: "The roster read on a temporary repository holds the roles committed on the base and not a role file that exists only in the checkout."
    - kind: "automated"
      check: "After a role file is added on the base and the base poll runs, the roster holds the new role; an invalid file raises one notice and leaves the other roles in place."
    - kind: "automated"
      check: "The gate passes R17 for a role label naming a roster role and fails R17 naming the role for one that is not in the roster."
    - kind: "automated"
      check: "The CI Ready gate script fails a Ready story whose role label has no role file in the checked-out repository, and passes it once the file is added."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A role file with version 1, a purpose and a non-empty body loads as a role named after its file, with its purpose, its instructions and its model and effort when set.
- [x] #2 A role file with an unknown frontmatter key, a missing version or purpose, a non-integer version or an empty body is refused with a message naming the file and the key or problem.
- [x] #3 A role file named reviewer, planner, auditor or scanner, or with a name that is not a valid role name, is refused with a message naming the file.
- [x] #4 Role files are read from the base commit, not the checkout: a role file that only exists in the checkout is not in the roster.
- [x] #5 A change to a role file on the base updates the roster without a daemon restart.
- [x] #6 An invalid role file leaves only that role out of the roster and raises one notice naming the file; the other roles stay in the roster.
- [x] #7 The daemon's Ready gate passes R17 for a story whose role label names a role file on the base, and fails R17 naming the role when no such file exists.
- [x] #8 The CI Ready gate script builds the roster from the role files of the checked-out commit, and fails R17 for a Ready story whose role has no file.
- [x] #9 The built-in roster constant is removed; the gate's roster comes only from role files.
- [x] #10 Decisions 0017, 0012, 0014 and 0001 describe role files, their keys and the roster as built here.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-13 10:08 UTC
- Criteria met: 10 of 10 (as the worker reported them)
- Loops: 1; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 1, failed 0
- Budget used: 124,101 of 800,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 0
<!-- SECTION:FINAL_SUMMARY:END -->
