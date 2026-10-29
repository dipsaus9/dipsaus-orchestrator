---
id: DIPO-370
title: Rename engine/src/hooks to questions
status: Done
assignee: []
created_date: '2026-10-29 08:06'
updated_date: '2026-10-29 20:59'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-351
references:
  - packages/engine/src/hooks/
modified_files:
  - .oxlintrc.json
  - packages/engine/src/create/runs.ts
  - packages/engine/src/hooks/index.ts
  - packages/engine/src/hooks/permissions.ts
  - packages/engine/src/hooks/questions.ts
  - packages/engine/src/questions/index.ts
  - packages/engine/src/questions/permissions.ts
  - packages/engine/src/questions/questions.ts
  - packages/engine/src/run/caps.ts
  - packages/engine/src/run/compose.ts
  - packages/engine/src/run/live-question.ts
  - packages/engine/src/run/park-records.ts
  - packages/engine/src/run/park-resume.ts
  - packages/engine/src/run/park.ts
  - packages/engine/src/run/resumption.ts
  - packages/engine/src/stories/discard.ts
  - packages/engine/src/views/desk.ts
  - packages/engine/src/views/feature.ts
  - packages/engine/src/views/summary.ts
  - packages/engine/src/worktree/done-elsewhere.ts
  - packages/engine/test/db/question-waits.test.ts
  - packages/engine/test/hooks/worker-questions.test.ts
  - packages/engine/test/questions/worker-questions.test.ts
  - packages/engine/test/reconcile/done-elsewhere.ci.test.ts
  - packages/engine/test/run/compose.test.ts
  - packages/engine/test/run/live-question.test.ts
  - packages/engine/test/run/resume-parks.test.ts
  - packages/engine/test/views/desk.test.ts
  - packages/engine/test/worktree/discard.ci.test.ts
  - test/lint-boundaries/fixtures/hooks-allowed.ts
  - test/lint-boundaries/fixtures/hooks-imports-claude-cli.ts
  - test/lint-boundaries/fixtures/questions-allowed.ts
  - test/lint-boundaries/fixtures/questions-imports-claude-cli.ts
  - test/lint-boundaries/lint-hooks.test.ts
  - test/lint-boundaries/lint-questions.test.ts
  - tools/lint/oxlint-plugin.js
priority: low
type: chore
ordinal: 350000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine's questions code lives in a folder named for what it does, and no folder or name says hooks.

From PR #417 (DIPO-347) on 2026-10-28: packages/engine/src/hooks/ now holds only the questions code (index.ts, permissions.ts, questions.ts), since no session has hooks (0008). The rename is mechanical.

```dipo
branch: "DIPO-370/rename-hooks-to-questions"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) bun run verify passes, and no file under packages/engine/src imports from a hooks folder"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 packages/engine/src/hooks/ is renamed to packages/engine/src/questions/ with every import updated, and no behaviour changes
- [x] #2 No source name or comment outside db/migrations still calls the questions code a hook; migration history and the questions table's hook column stay as they are
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-10-29 20:59 UTC
- Criteria met: 2 of 2 (as the worker reported them)
- Loops: 0; CI attempts: 0
- Review rounds: 1, failed 0
- Budget used: 42,969 of 300,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 0
<!-- SECTION:FINAL_SUMMARY:END -->
