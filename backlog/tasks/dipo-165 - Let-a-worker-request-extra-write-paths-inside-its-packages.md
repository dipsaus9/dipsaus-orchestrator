---
id: DIPO-165
title: Let a worker request extra write paths inside its packages
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-18 14:32'
labels:
  - 'tier:L'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-143
  - DIPO-159
  - DIPO-158
  - DIPO-164
  - DIPO-133
  - DIPO-139
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
ordinal: 136250
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a blocked report with a scopeRequest is granted by code inside the story's packages, refused outside them or outside the worktree, asked on the desk for restricted files, and grants reach the task file and the scope check; scope.packages and scope.restricted arrive in the next office config version.

Context: implements ADR 0020 section 11a (extra write paths; maintainer decision a worker can ask for more and spike answer 3), the needs-scope row of the section 2 matrix, and the contract and database changes of sections 14 and 15: QuestionKind becomes open with scope, and the questions.kind SQL check of migration 22 gains scope. Config version after DIPO-164's worker.web.

```dipo
branch: "DIPO-165/worker-scope-requests"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) each decision step of section 11a with one request per outcome: invalid, other package, collision, R26, restricted, granted"
    - kind: "automated"
      check: "(unit) a symlink that resolves outside the worktree is refused"
    - kind: "automated"
      check: "(integration, real git) a grant adds the reference on the story branch and the scope check at done accepts the granted path"
    - kind: "automated"
      check: "(unit) an unanswered restricted request parks needs-scope and an allow answer resumes it with the grant"
    - kind: "automated"
      check: "(migration) questions.kind accepts scope and has paths"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 WorkerReport gains scopeRequest { paths, why }, sent with status blocked, in the report schema, and the WorkerPort lists the paths its deny rules protect
- [ ] #2 Code decides each path in the section 11a order: refused when invalid (R12, under backlog/, .dipo/ or .git/, a deny-rule path, or resolving outside the worktree through a symlink), refused outside the packages the story writes, refused naming the story when it collides with another live claim, refused when R26 would break, waiting when restricted, else granted
- [ ] #3 The package of a path is its workspace member's directory, else its top-level directory, and a root file belongs to none; office keys scope.packages and scope.restricted (defaults dependency manifests and lockfiles, .github/**, CLAUDE.md, AGENTS.md, docs/decisions/**, which an office may add to and not remove from) arrive in the next config version with migration and schema
- [ ] #4 A grant adds the paths with `backlog task edit --add-ref` in a lane-a commit <ID>: scope add <paths>, records a scope grant in run_grants and a closed questions row kind scope decided by rule, and the waiting session is told the paths are now in scope; the scope check at done reads the start scope plus granted paths
- [ ] #5 A restricted path stores a questions row kind scope with its paths, waits timeouts.questionWaitMinutes as a SCOPE desk row, and parks needs-scope when unanswered; dipo answer <question> allow|deny [reason] decides it now or resumes the park, and dipo resume answers resume.decisionRequired
- [ ] #6 The scope nudge and the worker contract say outside the declared scope; if the story needs it, report blocked with a scopeRequest, in place of will be rejected
<!-- AC:END -->
