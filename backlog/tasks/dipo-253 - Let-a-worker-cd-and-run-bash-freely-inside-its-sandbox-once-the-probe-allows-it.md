---
id: DIPO-253
title: >-
  Let a worker cd and run bash freely inside its sandbox once the probe allows
  it
status: To Do
assignee: []
created_date: '2026-10-20 20:20'
updated_date: '2026-10-20 20:26'
labels:
  - 'tier:S'
  - cutover
  - needs-info
milestone: m-1
dependencies:
  - DIPO-252
  - DIPO-148
references:
  - packages/engine/src/workers/claude-cli/plan.ts
  - packages/engine/test/workers/plan.test.ts
  - packages/engine/test/workers/golden/
  - packages/engine/src/prompts/contract/implement.md
  - packages/engine/test/prompts/golden/system-implement-developer.md
priority: high
type: enhancement
ordinal: 136460
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker can `cd`, run `sed -i` and write files from scripts inside its worktree without the Claude CLI asking for approval, while its Read and Edit tools and its Bash commands stay fenced to the worktree and the toolchain, and the contract no longer forbids `cd`.

Context: the maintainer's decision D1 of 2026-10-20 (answer B), gated on DIPO-252's probe. The plan in packages/engine/src/workers/claude-cli/plan.ts writes the run settings, including `blockReadsOutsideWorkingDirectories: true`; the contract in packages/engine/src/prompts/contract/implement.md has the Working directory rule (never `cd`) and the Calls that need approval section (DIPO-232), whose golden is packages/engine/test/prompts/golden/system-implement-developer.md; the golden plan files are in packages/engine/test/workers/golden/. The write list stays the whole worktree; scope is checked at the end of the run as today.

```dipo
branch: "DIPO-253/worker-cd-freely"
unknowns:
  - q: "Which run setting does DIPO-252's probe show must be switched off, and do the Read and Edit tools stay refused outside the worktree with it off? This story's criteria name that setting once the probe's facts and its 0008 note exist; until then it stays To Do."
    status: "open"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) plan.test.ts: the worker run settings switch off the setting the probe names, and keep every deny rule and sandbox read and write path as before"
    - kind: "automated"
      check: "(golden) the plan goldens and the system prompt golden match the new settings and contract text"
    - kind: "manual"
      check: "(live) on the scratch repo, run a story whose change renames one symbol in several files"
      expect: "the worker's cd, sed -i and script writes run with no permission_denied event"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The worker run settings in packages/engine/src/workers/claude-cli/plan.ts switch off the CLI setting that the probe of the Context named, and keep every deny rule, the sandbox read and write paths and the network rules unchanged
- [ ] #2 packages/engine/src/prompts/contract/implement.md no longer forbids `cd` and no longer asks for one command per Bash call; it keeps the rule to stay inside the worktree, and its golden is updated
- [ ] #3 packages/engine/test/workers/plan.test.ts and the golden files cover the new settings and show the deny rules and sandbox paths unchanged
<!-- AC:END -->
