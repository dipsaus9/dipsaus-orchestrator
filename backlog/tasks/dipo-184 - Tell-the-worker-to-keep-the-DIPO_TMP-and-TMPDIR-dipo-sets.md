---
id: DIPO-184
title: Tell the worker to keep the DIPO_TMP and TMPDIR dipo sets
status: Refined
assignee: []
created_date: '2026-10-17 17:24'
updated_date: '2026-10-17 17:24'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/prompts/contract/implement.md
  - packages/engine/test/prompts/
priority: medium
type: bug
ordinal: 173000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the worker uses the DIPO_TMP and TMPDIR that dipo sets for its run instead of overriding them, so it does not lose turns to EPERM from temp paths its sandbox cannot write.

Context: the first M1a run, DIPO-123 (run_01M55CQA2468N35QN7V2D5S9MY). The worker ran `DIPO_TMP=/tmp bun test ...`, which failed with EPERM on mkdtemp inside the sandbox, probably because this repository's CLAUDE.md says tests write under DIPO_TMP with the fallback /tmp. dipo sets DIPO_TMP to the run's short temp root (packages/engine/src/workers/claude-cli/plan.ts, DIPO-118) and TMPDIR to the run temp directory, both writable in the sandbox, and the dry run lists them in the environment. The worker's system prompt is L1, packages/engine/src/prompts/contract/implement.md, followed by the developer role; neither mentions the two variables. L1+L2 stay byte-identical for every story with the same role (0014 section 5), so the line names the variables, never their paths.

```dipo
branch: "DIPO-184/worker-keeps-dipo-tmp"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(golden) the rendered system file holds the DIPO_TMP and TMPDIR rule"
    - kind: "manual"
      check: "(live) on the scratch repo, run a story whose tests write temp files"
      expect: "the worker runs its tests without setting DIPO_TMP or TMPDIR on the command line"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 L1 (packages/engine/src/prompts/contract/implement.md) states that TMPDIR and DIPO_TMP are set for the run to directories the sandbox lets the worker write, that commands use them as set, and that a command never sets either to another path, even where project rules name a fallback
- [ ] #2 The new text holds no path, id or date, and the golden file packages/engine/test/prompts/golden/system-implement-developer.md is updated and its test passes
<!-- AC:END -->
