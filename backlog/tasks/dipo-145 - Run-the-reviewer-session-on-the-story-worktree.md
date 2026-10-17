---
id: DIPO-145
title: Run the reviewer session on the story worktree
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-17 12:52'
labels:
  - 'tier:L'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-139
  - DIPO-142
references:
  - packages/engine/src/workers/
  - packages/engine/src/prompts/
  - packages/engine/test/workers/
  - packages/engine/test/prompts/
  - packages/engine/test/recordings/claude-cli/
  - tools/recordings/
priority: high
type: feature
ordinal: 134000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the Claude adapter plans the review kind with a read-only tool set and sandbox, a self-test variant, no plugins, skills or MCP servers and its own report schema, with a golden-tested L1 and reviewer role and the review task message, and live recordings exist.

Context: implements ADR 0019 section 4 (the reviewer session: who, tools, hygiene, what it receives) and the report schema of section 5, with the 0008 amendment of 2026-10-16 (DIPO-131). Today KNOWN_WORKER_KINDS holds review but the adapter plans only implement, one report schema exists, and prompts/ has only the implement contract and the developer role (0019 fact 9).

```dipo
branch: "DIPO-145/reviewer-session-review-kind"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the review plan's argv and run settings: tool list, denyWrite entries, closed network, no plugins, skills or MCP servers"
    - kind: "automated"
      check: "(golden) L1 and L2 of the review kind"
    - kind: "automated"
      check: "(unit) the review task message holds the section 4 inputs and none of the worker's report, notes or handoff"
    - kind: "automated"
      check: "(replay) the approval, blocked and invalid-report recordings parse into the review report schema or its error"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The Claude adapter plans the review kind with --tools Read,Glob,Grep,Bash and no Edit, Write, WebSearch or WebFetch; the story worktree, <main>/.git and the <worktree>/.git pointer are in denyWrite; the network is closed with no Safe-Chain proxy; model and effort come from the review config
- [ ] #2 The review session self-test writes its control file in the run temp root and requires an install to fail, and the 0008 fail-closed launch checks apply unchanged
- [ ] #3 Every installed plugin is switched off, --disable-slash-commands and --strict-mcp-config with an empty config are passed, and a system/init that lists a plugin or a skill refuses the session
- [ ] #4 WorkerPort.reportSchema is per kind, and the review kind's schema is the ReviewReport of section 5 (criteria, findings with testEntry, summary of at most 1,500 characters)
- [ ] #5 prompts/contract/review.md (L1) and the reviewer role (L2) are golden-tested, and the review task message (L4) carries the section 4 inputs (story facts, criteria, scope, numbered test plan, resolved unknowns, gate script changes, changed paths with line counts, the diff without the task file within budget, previous findings on a re-review) and never the worker's report, notes, handoff or transcript
- [ ] #6 Live recordings of an approval, a blocked verdict and an invalid report are stored under packages/engine/test/recordings/claude-cli/ with the tools/recordings/ script, and replay tests read them
<!-- AC:END -->
