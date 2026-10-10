---
id: DIPO-5
title: Define the worker adapter contract
status: Done
assignee: []
created_date: '2026-10-09 19:17'
updated_date: '2026-10-10 20:05'
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
- [x] #1 ADR docs/decisions/0008-worker-adapter.md defines the interface and event mapping
- [x] #2 ADR documents verified Claude CLI headless behavior with sources, including unattended permission handling and limit errors
- [x] #3 ADR states how another adapter would plug in
- [x] #4 Maintainer approved the decision
- [x] #5 ADR documents which per-job caps the Claude CLI supports on a Max login (tokens, turns, time, model selection) and how tiers S, M, L map onto them
- [x] #6 ADR documents what usage data the CLI reports per run
- [x] #7 ADR defines Claude telemetry from hooks (live state; an input or permission wait means the maintainer is needed, final state name chosen in DIPO-6) and transcript tailing (token usage per session and subagent), bound to the story by the engine (research idea 3)
- [x] #8 ADR defines resuming a native Claude session instead of starting over (research ideas 8 and 15)
- [x] #9 Anything installed into the repository or agent config (such as hooks) is additive and removable (research idea 12)
- [x] #10 ADR defines how per-run token usage maps to the pricing catalog for an estimated cost (research idea 4)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Scope addition (decision 0011): verify which per-job caps the Claude CLI supports on a Max login (tokens, turns, time, model selection). Tiers S, M, L map to model, budget and loop cap.

Draft ADR 0008 by research agent. Reviews: block (permission model outside worktree), block (shared .git writes, unsandboxed engine verify, min version), block (engine git on worker-writable metadata); all fixed: strict Bash sandbox from --settings, full .git write deny, hardened engine git, srt for engine install/verify, Claude Code >= 2.1.285. Waiting for maintainer approval.

Review: two rounds on PR #15. Round 1: absolute Edit/Write denies on the main checkout and its .git, what binds, live recordings, advisories (model switch, startFailed holds, credits hold, exact allow-once); maintainer chose to strip permission-widening keys from the copied local settings. Round 2: project settings.json permission keys refused unless allowlisted, re-check of stripped keys at every launch, initRejected outcome, no --add-dir, allow once cannot lift sandbox blocks, 0010 amendments (stripping, worktree root outside main checkout, teardown remote delete). All findings fixed.

Review round 3: project and local settings checked against a key allowlist (unknown keys fail closed, plugins refused), worker-failed wording aligned in 0001, 0005, 0012.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
ADR 0008 accepted: one long-lived claude -p per run on the Max login, token budgets per tier (S 300k, M 800k, L 2M; cache reads not counted), permissions asked when the maintainer is present else denied, park needs-permission when blocked, plan limits always wait for reset, second crash or init rejection parks worker-failed, setting sources project,local with a safe-key allowlist and stripped local permission keys, OS-level deny of .git/gh/main checkout/secrets with a fail-closed self-test, install and verify inside srt. Four review rounds. Amends 0001, 0005, 0010, 0012.
<!-- SECTION:FINAL_SUMMARY:END -->
