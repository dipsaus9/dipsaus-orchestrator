---
id: DIPO-209
title: >-
  Write golden files and derived recordings that pass the formatter when they
  are regenerated
status: In Review
assignee: []
created_date: '2026-10-18 14:32'
updated_date: '2026-10-19 22:36'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/test/workers/plan.test.ts
  - packages/engine/test/workers/golden/
  - packages/engine/test/sandbox/policy.test.ts
  - packages/engine/test/sandbox/golden/
  - tools/recordings/format.ts
  - tools/recordings/
priority: low
type: chore
ordinal: 209000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: regenerating the golden files (DIPO_UPDATE_GOLDEN=1) or the derived recordings (bun run recordings:derive) writes files that `bun run format:check` accepts, so a worker that regenerates them does not fail verify on formatting.

Context: M1a run of DIPO-204 on 2026-10-18 and its review (PR #210). The golden writer in packages/engine/test/workers/plan.test.ts writes `JSON.stringify(value, null, 2)`, while oxfmt puts short arrays such as denyRead and allowRead on one line, so a regenerated golden fails format:check until format:fix runs. The worker had to reformat them by hand. packages/engine/test/sandbox/policy.test.ts (around line 50) has the same writer for packages/engine/test/sandbox/golden/. Both comparisons read parsed JSON, so only the written text changes.

0017 allows test writes only under DIPO_TMP, so the automated check writes the regenerated text there and runs oxfmt --check on it with the repository's oxfmt configuration (.oxfmtrc.json), never in the repository.

The same holds for tools/recordings/derive.ts: running bun run recordings:derive rewrites packages/engine/test/recordings/claude-cli/model-switch/meta.json because serializeMeta writes cites as a multi-line array while the committed file has oxfmt's one-line array (review of PR #231). Generated files should pass format:check as written.

```dipo
branch: "DIPO-209/formatted-golden-plans"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the meta.json that serializeMeta writes passes oxfmt --check with .oxfmtrc.json, written under DIPO_TMP"
    - kind: "automated"
      check: "(unit) the text each golden writer produces, written under DIPO_TMP, passes oxfmt --check with the repository's oxfmt configuration"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The golden writers in packages/engine/test/workers/plan.test.ts and packages/engine/test/sandbox/policy.test.ts write text in the formatter's own layout, so regenerating with DIPO_UPDATE_GOLDEN=1 leaves packages/engine/test/workers/golden/ and packages/engine/test/sandbox/golden/ with no formatting change
- [x] #2 A test writes the text each writer produces for its goldens under DIPO_TMP, runs oxfmt --check there with the repository's .oxfmtrc.json, and expects exit 0
- [x] #3 The committed golden files are unchanged in content, and bun run verify passes
- [x] #4 serializeMeta in tools/recordings/format.ts writes meta.json in the formatter's layout, so bun run recordings:derive leaves the committed derived recordings (model-switch/meta.json among them) unchanged and a test checks its output with oxfmt --check under DIPO_TMP
<!-- AC:END -->
