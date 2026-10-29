---
id: DIPO-370
title: Rename engine/src/hooks to questions
status: Refined
assignee: []
created_date: '2026-10-29 08:06'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-351
references:
  - packages/engine/src/hooks/
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
- [ ] #1 packages/engine/src/hooks/ is renamed to packages/engine/src/questions/ with every import updated, and no behaviour changes
- [ ] #2 No source name, comment or log line still calls the questions code a hook
<!-- AC:END -->
