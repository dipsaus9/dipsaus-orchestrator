---
id: DIPO-10
title: Design worker prompt assembly
status: In Progress
assignee: []
created_date: '2026-10-09 19:59'
updated_date: '2026-10-10 11:42'
labels:
  - architecture
milestone: m-0
dependencies:
  - DIPO-8
priority: high
type: spike
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an ADR defining how the engine builds each worker's prompt from templates plus structured data (role, story fields, office context, prior feedback such as reviewer findings or the maintainer's test notes) so workers never read a process manual. This is the project's core token-saving claim. Cover: template structure and where templates live, what context is included or left out, how mechanical steps (git, worktrees, verify) stay in code and out of the prompt, how prompts stay short and stable, and how token savings are measured against the dipsaus-ai skills baseline. See docs/vision.md and docs/decisions/0011-office-model.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 ADR docs/decisions/0014-worker-prompt-assembly.md defines the template structure and the data each prompt receives
- [x] #2 ADR lists which steps stay in code and never appear in a prompt
- [x] #3 ADR defines how token use is measured and compared with the dipsaus-ai backlog-deliver baseline
- [ ] #4 Maintainer approved the decision
- [x] #5 Prompts carry pre-fetched facts, every section has a size budget with a truncation marker, and the worker is told not to re-fetch (research idea 13)
- [x] #6 Feedback to a worker (CI, review, test notes) carries the evidence: log tails, file and line, comment text (research idea 14)
- [x] #7 ADR defines a budgeted handoff between sessions or roles, and resuming a native session before starting a new one (research idea 15)
- [x] #8 ADR defines conditional short context nudges through hooks, only when a fact makes them relevant (research idea 16)
- [x] #9 ADR compares codegraph with the alternatives in research section 7.6 (Aider repo map, Serena, code-graph-rag) as candidate optional context backends, with a recommendation (research idea 19, narrowed by the decision in section 7.7)
- [x] #10 ADR defines a context provider interface that decides which code a worker sees, with a default provider using the story's scope, inputs and the declared component map (research idea 23)
- [x] #11 ADR defines codegraph as an optional context backend called through its CLI with --json, result size-capped, telemetry off, version pinned, optionally enabled as MCP for workers (research idea 24)
- [x] #12 ADR defines how a context backend is measured on real stories against the dipsaus-ai baseline before it may become a default (research idea 25)
- [x] #13 ADR defines context output budgets that grow with project size (research idea 26)
- [x] #14 ADR defines how a stale context index is detected and reported, and reconciled from content hashes after a restart (research idea 27)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Draft ADR 0014 by research agent. Review: pass, 10 advisories applied (verify and commit only at In Review, base sync on conflict or riskier, reviewer never resumed, measurement schedule on Max, privacy, research 7.3 correction). Waiting for maintainer approval.
<!-- SECTION:NOTES:END -->
