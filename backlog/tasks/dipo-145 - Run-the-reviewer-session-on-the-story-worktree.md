---
id: DIPO-145
title: Run the reviewer session on the story worktree
status: In Review
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-19 09:19'
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
  - packages/engine/src/run/launch.ts
  - packages/engine/src/index.ts
  - packages/engine/test/workers/
  - packages/engine/test/prompts/
  - packages/engine/test/run/
  - packages/engine/test/recordings/claude-cli/
  - tools/recordings/
priority: high
type: feature
ordinal: 134000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the Claude adapter plans the review kind with a read-only tool set and sandbox, a self-test variant, no plugins, skills or MCP servers and its own report schema, with a golden-tested L1 and reviewer role and the review task message, and replay tests over derived review recordings.

Context: implements ADR 0019 section 4 (the reviewer session: who, tools, hygiene, what it receives) and the report schema of section 5, with the 0008 amendment of 2026-10-16 (DIPO-131). Today KNOWN_WORKER_KINDS holds review but the adapter plans only implement, one report schema exists, and prompts/ has only the implement contract and the developer role (0019 fact 9).

DIPO-142 built the worker place and the reviewer place (packages/engine/src/run/places.ts). For this story's adapter plan: the reviewer place exists, and it takes its model from review.model (PlacesDeps.reviewModel). The review starter and the pending reviews that start sessions in that place belong to DIPO-146. runWorkerSpec (packages/engine/src/run/launch.ts) builds every spec as kind implement, with model and effort from the tier caps, DEVELOPER_TOOLS and worker.reportSchema; AC1 and AC4 make it per kind. tools/recordings imports the engine through packages/engine/src/index.ts.

The worker sandbox has no network, so a worker cannot run claude to capture a live recording. The review recordings it commits are derived by tools/recordings/derive.ts from committed live recordings, as report-invalid is, with every field no live run showed listed in meta.cites. The maintainer captures the live ones with the review scenarios this story adds (manual test plan entry).

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
      check: "(unit) the review self-test writes its control file in the run temp root, not the worktree, and passes only when its install probe fails; an install that succeeds refuses the session"
    - kind: "automated"
      check: "(unit) a review session whose system/init lists a plugin is refused, and so is one whose system/init lists a skill"
    - kind: "automated"
      check: "(unit) the review spec from runWorkerSpec has kind review, review.model and review.effort, and the ReviewReport schema with testEntry and the 1,500 character summary cap"
    - kind: "automated"
      check: "(replay) the derived approval, blocked and invalid-report recordings parse into the review report schema or its error"
    - kind: "manual"
      check: "(live, on the maintainer's machine with network) run bun run recordings:capture for the three review scenarios: an approval, a blocked verdict and an invalid report"
      expect: "each recording is written under packages/engine/test/recordings/claude-cli/ with source live, its system/init lists the tools Read, Glob, Grep and Bash and no plugin or skill, and the review replay tests pass on it"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The Claude adapter plans the review kind with --tools Read,Glob,Grep,Bash and no Edit, Write, WebSearch or WebFetch; the story worktree, <main>/.git and the <worktree>/.git pointer are in denyWrite; the network is closed with no Safe-Chain proxy; model and effort come from the review config
- [x] #2 The review session self-test writes its control file in the run temp root and requires an install to fail, and the 0008 fail-closed launch checks apply unchanged
- [x] #3 Every installed plugin is switched off, --disable-slash-commands and --strict-mcp-config with an empty config are passed, and a system/init that lists a plugin or a skill refuses the session
- [x] #4 WorkerPort.reportSchema is per kind, and the review kind's schema is the ReviewReport of section 5 (criteria, findings with testEntry, summary of at most 1,500 characters)
- [x] #5 prompts/contract/review.md (L1) and the reviewer role (L2) are golden-tested, and the review task message (L4) carries the section 4 inputs (story facts, criteria, scope, numbered test plan, resolved unknowns, gate script changes, changed paths with line counts, the diff without the task file within budget, previous findings on a re-review) and never the worker's report, notes, handoff or transcript
- [x] #6 tools/recordings/derive.ts derives an approval, a blocked verdict and an invalid review report from committed live recordings into packages/engine/test/recordings/claude-cli/, with the fields no live run showed in meta.cites; tools/recordings/scenarios.ts gains the three review scenarios for bun run recordings:capture; and replay tests parse each recording into the review report schema or its error
<!-- AC:END -->
