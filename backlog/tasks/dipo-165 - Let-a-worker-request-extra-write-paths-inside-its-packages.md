---
id: DIPO-165
title: Let a worker request extra write paths inside its packages
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-20 20:44'
labels:
  - 'tier:L'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-133
  - DIPO-139
  - DIPO-143
  - DIPO-158
  - DIPO-159
  - DIPO-164
  - DIPO-258
  - DIPO-148
  - DIPO-252
  - DIPO-253
  - DIPO-260
  - DIPO-244
  - DIPO-247
references:
  - packages/contract/src/
  - packages/contract/schema/
  - packages/engine/src/workers/
  - packages/engine/src/run/
  - packages/engine/src/hooks/
  - packages/engine/src/prompts/
  - packages/engine/src/config/
  - packages/engine/src/scan/
  - packages/engine/schema/
  - packages/engine/scripts/write-schema.ts
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/src/views/
  - packages/engine/test/run/
  - packages/engine/test/workers/
  - packages/engine/test/config/
  - packages/engine/test/office/
  - packages/engine/test/db/
  - docs/decisions/
priority: high
type: feature
ordinal: 137100
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a scope request for a restricted file waits for the maintainer's answer on the desk and parks needs-scope when unanswered, a granted path is added to the task file's References, and scope.packages and scope.restricted arrive in the next office config version after DIPO-260's; the structured request and the code grant inside the story's own packages are DIPO-258.

Context: the maintainer's decision D6 of 2026-10-20 split this story: DIPO-258 (165a) adds the scopeRequest field, the code decision and the recorded grant with no dependency on the desk or the question wait; this story (165b) keeps the rest and its dependencies on DIPO-158 and DIPO-159. Implements ADR 0020 section 11a (extra write paths; maintainer decision a worker can ask for more and spike answer 3), the needs-scope row of the section 2 matrix, and the contract and database changes of sections 14 and 15: QuestionKind becomes open with scope, and the questions.kind SQL check of migration 22 gains scope. Config version after DIPO-164's worker.web.

```dipo
branch: "DIPO-165/worker-scope-requests"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a request for a scope.restricted path stores a questions row kind scope with its paths, waits timeouts.questionWaitMinutes as a SCOPE desk row, and parks needs-scope when unanswered; an allow answer resumes it with the grant"
    - kind: "automated"
      check: "(integration, real git) a grant adds the reference on the story branch in a lane-a commit and the scope check at done accepts it"
    - kind: "automated"
      check: "(migration) questions.kind accepts scope and has paths; the office keys scope.packages and scope.restricted have their defaults"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Office keys scope.packages and scope.restricted (defaults: dependency manifests and lockfiles, .github/**, CLAUDE.md, AGENTS.md, docs/decisions/**, which an office may add to and not remove from) arrive in the next config version after DIPO-260's, with migration and schema, and the code decision of DIPO-258 treats a path matched by scope.restricted as waiting instead of granted, and uses scope.packages for the package of a path when it is set
- [ ] #2 A restricted path stores a questions row kind scope with its paths, waits timeouts.questionWaitMinutes as a SCOPE desk row, and parks needs-scope when unanswered; dipo answer <question> allow|deny [reason] decides it now or resumes the park, and dipo resume answers resume.decisionRequired
- [ ] #3 A grant also adds the paths to the task file with `backlog task edit --add-ref` in a lane-a commit <ID>: scope add <paths>, and records a closed questions row kind scope decided by rule
- [ ] #4 Tests cover the restricted wait, the park and the resume with an answer, the lane-a commit, the migration and the office key defaults
<!-- AC:END -->
