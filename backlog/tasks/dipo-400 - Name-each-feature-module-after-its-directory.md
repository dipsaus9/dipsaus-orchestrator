---
id: DIPO-400
title: Name each feature module after its directory
status: Done
assignee: []
created_date: '2026-10-30 22:14'
updated_date: '2026-10-31 10:58'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-389
  - DIPO-394
references:
  - packages/engine/src/gate-decisions/feature.ts
  - packages/engine/src/backlog/init/init.ts
  - packages/engine/src/features.ts
modified_files:
  - packages/engine/src/backlog/init/init.ts
  - packages/engine/src/create/control.ts
  - packages/engine/src/create/steps.ts
  - packages/engine/src/gate-decisions/feature.ts
  - packages/engine/src/merge/commands.ts
  - packages/engine/src/overview/feature.ts
  - packages/engine/src/questions/permissions.ts
  - packages/engine/src/reads/describe.ts
  - packages/engine/src/reads/hello.ts
  - packages/engine/src/retention/stats.ts
  - packages/engine/src/run-state/places.ts
  - packages/engine/src/run/control.ts
  - packages/engine/src/run/discard.ts
  - packages/engine/src/run/intervene.ts
  - packages/engine/src/run/outcome-restart.ts
  - packages/engine/src/run/planning.ts
  - packages/engine/src/run/proposals.ts
  - packages/engine/src/run/starts-paused.ts
  - packages/engine/src/run/tests.ts
  - packages/engine/src/run/usage-alerts.ts
  - packages/engine/src/run/work-resume.ts
  - packages/engine/src/story-pr/pr-state.ts
  - packages/engine/src/worktree/done.ts
  - packages/engine/src/worktree/feature.ts
  - packages/engine/test/commands/registry.test.ts
  - packages/engine/test/features.test.ts
priority: low
type: chore
ordinal: 378000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: every engine feature module registers under the name of the directory it lives in, so a registration error names the right place.

Found by the review of PR #486 (DIPO-389): the story.gate feature moved to gate-decisions/ but still registers as "gate/store" (gate-decisions/feature.ts), and backlog/init/init.ts registers "office/init". The layer moves left the names alone on purpose, since changing them changes error text. 0004, 0001.

```dipo
branch: "DIPO-400/feature-names-follow-dirs"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a test lists every registered feature name and checks it matches its module directory"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Every feature module registers under its directory's name (gate-decisions, backlog/init and any other stale name found), and no test or message still names the old ones
- [x] #2 A test reads every registered feature name and fails when one does not match its module's directory
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-10-31 10:58 UTC
- Criteria met: 2 of 2 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 1, failed 0
- Budget used: 78,263 of 300,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 1
<!-- SECTION:FINAL_SUMMARY:END -->
