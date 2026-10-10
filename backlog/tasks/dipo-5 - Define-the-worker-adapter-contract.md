---
id: DIPO-5
title: Define the worker adapter contract
status: To Do
assignee: []
created_date: '2026-10-09 19:17'
updated_date: '2026-10-10 10:18'
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
- [ ] #5 ADR documents which per-job caps the Claude CLI supports on a Max login (tokens, turns, time, model selection) and how tiers S, M, L map onto them
- [ ] #6 ADR documents what usage data the CLI reports per run
- [ ] #7 ADR defines Claude telemetry from hooks (live state; input or permission wait means needs-you) and transcript tailing (token usage per session and subagent), bound to the story by the engine (research idea 3)
- [ ] #8 ADR defines resuming a native Claude session instead of starting over (research ideas 8 and 15)
- [ ] #9 Anything installed into the repository or agent config (such as hooks) is additive and removable (research idea 12)
- [ ] #10 ADR defines how per-run token usage maps to the pricing catalog for an estimated cost (research idea 4)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Scope addition (decision 0011): verify which per-job caps the Claude CLI supports on a Max login (tokens, turns, time, model selection). Tiers S, M, L map to model, budget and loop cap.
<!-- SECTION:NOTES:END -->
