---
id: DIPO-477
title: Run each story as the role its label names
status: Done
assignee: []
created_date: '2026-11-10 15:05'
updated_date: '2026-11-15 21:24'
labels:
  - 'tier:L'
  - 'role:developer'
milestone: m-4
dependencies:
  - DIPO-471
  - DIPO-472
  - DIPO-476
references:
  - packages/engine/src/gate/rules.ts
  - packages/engine/src/run/work-run.ts
  - packages/engine/src/run/prompts.ts
  - packages/engine/src/run/resume.ts
  - packages/engine/src/run/launch.ts
  - packages/engine/src/prompts/system.ts
  - packages/engine/src/prompts/templates.ts
  - packages/engine/src/records/
  - packages/engine/src/db/migrations/
  - packages/engine/src/views/work.ts
  - docs/decisions/0012-story-standard.md
  - docs/decisions/0014-worker-prompt-assembly.md
  - docs/decisions/0001-foundational-decisions.md
modified_files:
  - docs/decisions/0001-foundational-decisions.md
  - docs/decisions/0012-story-standard.md
  - docs/decisions/0014-worker-prompt-assembly.md
  - packages/cli/src/run-command.ts
  - packages/contract/schema/reads.schema.json
  - packages/contract/src/office.ts
  - packages/contract/test/fixtures.ts
  - packages/daemon/test/integration/reattach-kill.ci.test.ts
  - packages/engine/src/backlog/init/ops.ts
  - packages/engine/src/db/migrations/0014-run-roles.ts
  - packages/engine/src/db/schema.ts
  - packages/engine/src/gate/rules.ts
  - packages/engine/src/prompts/index.ts
  - packages/engine/src/prompts/system.ts
  - packages/engine/src/prompts/templates.ts
  - packages/engine/src/records/run-records.ts
  - packages/engine/src/records/run-starts.ts
  - packages/engine/src/run/idea-audits.ts
  - packages/engine/src/run/index.ts
  - packages/engine/src/run/launch.ts
  - packages/engine/src/run/planning-session.ts
  - packages/engine/src/run/prompts.ts
  - packages/engine/src/run/resume.ts
  - packages/engine/src/run/review-launch.ts
  - packages/engine/src/run/work-run.ts
  - packages/engine/src/scan/request.ts
  - packages/engine/src/views/work.ts
  - packages/engine/test/db/migrations.test.ts
  - packages/engine/test/engine/loop-office.ts
  - packages/engine/test/gate-decisions/store.test.ts
  - packages/engine/test/gate/fixtures.ts
  - packages/engine/test/gate/gate.test.ts
  - packages/engine/test/gate/gated-office.ts
  - packages/engine/test/gate/story-gate.ci.test.ts
  - packages/engine/test/gate/story-gate.test.ts
  - packages/engine/test/office/forget.test.ts
  - packages/engine/test/prompts/review.test.ts
  - packages/engine/test/prompts/store.test.ts
  - packages/engine/test/prompts/system.test.ts
  - packages/engine/test/run/next-up.test.ts
  - packages/engine/test/run/planning-confirm-ready.test.ts
  - packages/engine/test/run/planning-questions.test.ts
  - packages/engine/test/run/reattach.test.ts
  - packages/engine/test/run/review-launch.test.ts
  - packages/engine/test/run/run-office.ts
  - packages/engine/test/run/start.test.ts
  - packages/engine/test/run/test-roles.ts
  - packages/engine/test/run/work-run.ci.test.ts
  - packages/engine/test/run/work-run.test.ts
  - scripts/check-backlog-pr.test.ts
  - scripts/check-ready-gate.test.ts
type: feature
ordinal: 450000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want each story to run with the instructions, model and effort of the role its label names so that roles I add as files do the work they are written for.

Today every run is the developer. Run start records DEVELOPER_ROLE (packages/engine/src/run/work-run.ts:139, used at 1222 and 1244; recordDeveloper at 329). The system file is always the bundled developer text (packages/engine/src/run/prompts.ts:92, packages/engine/src/run/resume.ts:374). Model and effort come only from the tier (packages/engine/src/run/launch.ts:324-325). The maintainer decided (planning 2026-11-10):
- A role label is required. R17 (packages/engine/src/gate/rules.ts:440) now asks for exactly one role label naming a roster role. With none it fails, saying a role label is needed and listing the roster's roles; dipo office init labels existing stories (DIPO-472).
- A run keeps the role it started with. A role file changed on the base later never changes a live or parked run's sessions, as a tier edit does not (DIPO-207, startTierOf at resume.ts:285).

Scope:
- At start, the run reads its role from the story's role label and takes the role from the roster (DIPO-471) loaded at the base it claims. It stores the role's name, instructions, model and effort with the run in the start transaction (#recordRun, work-run.ts:1205), the way the config snapshot is stored. A new migration is likely.
- The run row, the agent rows and work.assigned carry that role, not developer.
- The system file is the implement-box contract plus the stored instructions. renderSystemFile (packages/engine/src/prompts/system.ts:14) takes the role text, and ROLE_TEMPLATES loses developer (packages/engine/src/prompts/templates.ts:71). The bundled developer.md stays as the seed text only. The system file is still byte-identical for the same kind and role text.
- Model and effort are the role's when set, else the tier's. The tier still gives budget, turns, minutes and loops (vision 5). The run's model and its first agent's effort hold the result, and startTierOf finds the first agent of the run's own role, not 'developer' (resume.ts:288).
- Every later session (resume, fix round, handoff) uses the stored role. A run started before this change has no stored role and keeps using the bundled developer text and the tier.
- The work preview names the role and the model it would use.
- The reviewer, planner, auditor and scanner stay engine code and are unchanged.

Amend 0012 (R17), 0014 section 1 (L2 is the run's role file) and 0001 Roles.

```dipo
branch: "DIPO-477/run-each-story-as-role-its-label-names"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "The gate fails R17 for no role label, for two role labels and for an unknown role, and passes it for one roster role."
    - kind: "automated"
      check: "Starting a run for a story labelled with a test role writes a system file that ends with that role file's instructions, and records the role on the run and its agent."
    - kind: "automated"
      check: "A role file with model and effort gives the worker spec that model and effort; without them the spec has the tier's, and both specs have the tier's caps."
    - kind: "automated"
      check: "After the role file is changed on the base, a resume of a parked run writes the system file and model the run started with."
    - kind: "automated"
      check: "A run row from before the change, with no stored role, resumes with the bundled developer system file."
    - kind: "manual"
      check: "Add a role file with its own model to a test office, label a Ready story with it and start the run."
      expect: "The run view shows the new role and its model, and the run's system file holds that role's instructions."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 R17 fails a story with no role label, saying a role label is needed and listing the roster's roles.
- [x] #2 R17 passes a story with exactly one role label naming a roster role, and fails one with two role labels or a role not in the roster.
- [x] #3 A run started for a story labelled role:<name> records <name> as the role of its run row, its agents and its work.assigned entry.
- [x] #4 The system file of the run's first session is the implement-box contract followed by the instructions of the labelled role file.
- [x] #5 A role file with a model and an effort runs its sessions with them; one without them runs with the tier's model and effort, and the tier's caps apply in both cases.
- [x] #6 After the role file changes on the base, a resumed or fix-round session of a run started earlier uses the instructions, model and effort the run started with.
- [x] #7 A run started before this change has no stored role, and its next session uses the bundled developer instructions and the tier's model and effort.
- [x] #8 The bundled developer text is no longer a run role: the developer role template is removed from the run's system file path.
- [x] #9 The work preview names the role and the model a story would run with.
- [x] #10 Decisions 0012, 0014 and 0001 describe that a story runs as its labelled role file.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-15 21:24 UTC
- Criteria met: 10 of 10 (as the worker reported them)
- Loops: 0; CI attempts: 1 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 3, failed 0
- Budget used: 550,178 of 2,000,000 tokens
- Runs: 1; resumes: 6
- Parks: 6
  - 2026-11-13 13:41 UTC ambiguous-spec: CI's ready-gate job will fail on this PR. R17 now requires a role label. This repository has no .dipo/roles/developer.md, and none of its 8 Ready stories has a role label (DIPO-475, 477, 478, 496, 49…
  - 2026-11-13 15:28 UTC ambiguous-spec: The ready-gate CI check fails because this repository, as an office, has no role file in .dipo/roles/ and its Ready stories DIPO-500 to DIPO-504 carry no role: label, which R17 now requires. Will you…
  - 2026-11-15 10:44 UTC worker-failed: dipo could not take the box's work as a part before merging main into the story branch, so it merged nothing and the box keeps its files: the box web route did not start: the box web route did not st…
  - 2026-11-15 12:10 UTC worker-failed: dipo could not take the box's work as a part before merging main into the story branch, so it merged nothing and the box keeps its files: the box web route did not start: the box web route did not st…
  - 2026-11-15 12:13 UTC worker-failed: dipo could not take the box's work as a part before merging main into the story branch, so it merged nothing and the box keeps its files: the box web route did not start: the box web route did not st…
  - 2026-11-15 14:43 UTC worker-failed: dipo could not take the box's work as a part before merging main into the story branch, so it merged nothing and the box keeps its files: the box web route did not start: the box web route did not st…
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 1
<!-- SECTION:FINAL_SUMMARY:END -->
