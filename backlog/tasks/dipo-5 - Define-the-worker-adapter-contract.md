---
id: DIPO-5
title: Define the worker adapter contract
status: To Do
assignee: []
created_date: '2026-10-09 19:17'
labels:
  - architecture
milestone: m-0
dependencies:
  - DIPO-1
priority: high
type: spike
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an ADR defining the Worker interface (start with prompt and workdir, stream events, accept steering, return structured result) and the first adapter wrapping the Claude Code CLI as a subprocess on the Max login. Investigate headless mode flags, streaming output format, session resume, permission handling for unattended runs, budget and turn caps, and how usage limits surface. Keep Claude specifics inside the adapter so an SDK or API-key adapter can be added later.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 ADR docs/decisions/0008-worker-adapter.md defines the interface and event mapping
- [ ] #2 ADR documents verified Claude CLI headless behavior with sources, including unattended permission handling and limit errors
- [ ] #3 ADR states how another adapter would plug in
- [ ] #4 Maintainer approved the decision
<!-- AC:END -->
