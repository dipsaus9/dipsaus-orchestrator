---
id: DIPO-258
title: Grant a worker's scope request inside its own packages by code
status: Refined
assignee: []
created_date: '2026-10-20 20:20'
updated_date: '2026-10-20 20:25'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies:
  - DIPO-257
references:
  - packages/engine/src/workers/types.ts
  - packages/engine/src/workers/claude-cli/report-schema.ts
  - packages/engine/src/run/control.ts
  - packages/engine/src/run/verify-commit.ts
  - packages/engine/src/run/grants.ts
  - packages/engine/src/prompts/review.ts
  - packages/engine/src/prompts/contract/implement.md
  - packages/engine/src/prompts/feedback/nudge-scope.md
  - packages/engine/test/workers/report-schema.test.ts
  - packages/engine/test/prompts/
  - packages/engine/test/run/control.test.ts
  - packages/engine/test/run/verify-commit.test.ts
priority: high
type: feature
ordinal: 136200
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker that needs a path outside its References asks for it in a structured report field, and code grants it when the path is inside the story's own packages and not in docs/decisions/, .dipo/, backlog/, .git/ or another live story's References; the grant is recorded and shown to the reviewer, and any other request parks as today.

Context: the maintainer's decision D6 of 2026-10-20 (answer A): DIPO-165 is split. This story is the first part (165a) and has no dependency on the desk (DIPO-158) or the question wait (DIPO-159); DIPO-165 keeps the rest (restricted paths that wait for an answer on the desk, the office keys and the task-file edit). Scope is the largest gap class of the M1 runs: about 12 stories, with parks (DIPO-139, 147, 164), skipped test-plan items (DIPO-227) and designs bent to stay in scope (DIPO-231's optional field, DIPO-209's duplicate helper; docs/research/2026-10-20-dipo-run-gaps.md section 3.1). WorkerReport is in packages/engine/src/workers/types.ts, its schema in packages/engine/src/workers/claude-cli/report-schema.ts; a blocked report is handled in packages/engine/src/run/control.ts; the scope check at done is in packages/engine/src/run/verify-commit.ts; run_grants already has kind scope (migration 0032, helpers in packages/engine/src/run/grants.ts). With D1 the worker's write list stays the whole worktree, so a grant widens only the end-of-run scope check. The package of a path is its workspace member's directory, else its top-level directory, and a root file belongs to none (0020 section 11a). The scope nudge text is packages/engine/src/prompts/feedback/nudge-scope.md.

```dipo
branch: "DIPO-258/scope-request-code-grant"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) one request per outcome: granted inside a package the story writes; refused for docs/decisions/, .dipo/, backlog/, .git/, a path outside the worktree or through a symlink, another package, and another live claim's References (naming that story)"
    - kind: "automated"
      check: "(unit) a granted request records a run_grants row kind scope with the paths and the reason, the session is told the paths are in scope, and the scope check at done accepts them"
    - kind: "automated"
      check: "(unit) the review task message lists each granted path with its reason; a refused request parks as a scope violation does today"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 WorkerReport gains `scopeRequest` { paths, why } (at most 5 paths, why at most 500 characters), sent with status blocked, in the type and the report JSON schema
- [ ] #2 Code decides each requested path: refused when it is not a valid repo-relative path, lies under docs/decisions/, .dipo/, backlog/ or .git/, resolves outside the worktree (also through a symlink), lies outside the packages the story's References touch, or is covered by another live claim's References (the refusal names that story); else granted
- [ ] #3 A request whose paths are all granted records one run_grants row of kind scope with the paths and the reason, tells the waiting session in one message that the paths are now in scope, and the scope check at done reads the run's start scope plus its granted paths; a request with any refused path parks the story as a scope violation does today, with the refused paths and reasons in the detail
- [ ] #4 The review task message lists each granted path with its reason, and the worker contract and nudge-scope.md say, with tool-neutral wording, to report blocked with a scopeRequest when a path outside the scope is needed instead of working around it
- [ ] #5 Tests cover each outcome of the decision, the recorded grant, the message to the session, the scope check at done, the review task message and the park on refusal
<!-- AC:END -->
