---
id: DIPO-484
title: dipo names the real cause of every failure
status: Refined
assignee: []
created_date: '2026-11-10 15:36'
updated_date: '2026-11-10 15:37'
labels:
  - 'tier:M'
milestone: m-3
dependencies: []
references:
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/src/box/model-proxy.ts
  - packages/engine/src/records/proxied-usage.ts
  - packages/engine/src/run/outcome-exits.ts
  - packages/engine/src/overview/desk.ts
  - packages/cli/src/ideas-command.ts
  - packages/tui/src/queue.tsx
  - packages/tui/src/chain.ts
  - packages/engine/src/backlog/pr/feature.ts
priority: high
type: bug
ordinal: 456000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want dipo to name the real cause when a run, an audit or a session fails or waits, so that I fix the right thing instead of waiting out a plan limit that was never hit.

M3 (0022), a bug from 2026-11-10. Evidence:
1. Idea audits ended "plan-limit" although dipo's own model proxy refused them (the cap bug fixed by DIPO-470). The misnaming stays: the worker adapter reads every 429 as the plan's limit (packages/engine/src/workers/claude-cli/interpret.ts:1223-1228, "a turn ended by a 429 is a rejected plan limit", and the `rate_limit` paths at :662-671 and :1056-1059), while the proxy answers 429 itself when a run's token cap is reached (packages/engine/src/box/model-proxy.ts:465, `refusal(429, "the run's token budget is used up", ...)`). A plan-limit pause stops the whole office (0020); a cap should end that one run, capped, with its reason.
2. Failed audits show only in the daemon log: nothing on the desk or in `dipo ideas` says an audit failed and why.
3. The TUI says "blocked" for stories that are only Refined and wait for Ready. The story finds the place that says it (candidates: the Queue's and Floor's chain state from `office.chain`, and the backlog PR check's `backlogCheckBlocked` in packages/engine/src/backlog/pr/feature.ts) and shows "Refined, not Ready yet" with the first gate failure instead, as the Queue's REFINED group does (packages/tui/src/queue.tsx:57-60).

Mechanism for 1 (one, 0001): the proxy records each refusal it sends in the engine, against the run, with its reason and time; the run's ending reads that record. A 429 in a turn for which the engine recorded a proxy refusal ends the run capped with the proxy's reason; a 429 with no such record is the plan's limit, as today. The worker's stream never decides it: no header or body marker is read, since text in the stream is the worker's to write. This replaces "every 429 is the plan's limit".

This changes a check (CLAUDE.md, R30): the old rule caught every real plan limit (a `rate_limit_event` rejected, an assistant `rate_limit` error, a turn ended by a 429) and paused the office; each keeps a test that still pauses it. Bypass forms to test: a worker that prints the proxy's refusal text or a fake "dipo proxy" marker in its output, in a tool result or in its report, around a real Anthropic 429; a proxy refusal recorded for another run; a refusal recorded after the turn ended. Each still reads as the plan's limit. The fail-closed test runs the real model proxy and the real interpreter on a fixture-built office: a 429 from upstream with no recorded refusal pauses the office.

```dipo
branch: "DIPO-484/name-the-real-cause"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a run whose token cap the proxy refuses with 429 ends capped with the proxy's reason and the office does not pause"
    - kind: "automated"
      check: "(unit) the old plan-limit cases (rate_limit_event rejected, assistant rate_limit error, turn ended by a 429) with no proxy refusal recorded still pause the office as plan-limit"
    - kind: "automated"
      check: "(unit) bypass forms: the proxy's refusal text or a fake proxy marker in worker output, in a tool result or in the report around a real 429, a refusal recorded for another run, and one recorded after the turn ended each still read as plan-limit"
    - kind: "automated"
      check: "(fail-closed) the real model proxy and interpreter on a fixture-built office: an upstream 429 with no recorded refusal pauses the office"
    - kind: "automated"
      check: "(unit) a failed or cut-off audit and a failed session show on the desk or in dipo ideas with their cause, and dipo ideas --json carries it"
    - kind: "automated"
      check: "(unit) a Refined story waiting for Ready never renders as blocked in the Queue, the Floor or the Desk; it shows Refined, not Ready yet, with its first gate failure"
    - kind: "manual"
      check: "On the scratch repository, give a run a tiny token budget so the proxy refuses it, and look at the Desk, the Floor and dipo ideas"
      expect: "The run ends capped with the proxy's reason, the office is not paused, and no Refined story says blocked"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The model proxy records each refusal it sends against its run, and a 429 in a turn with a recorded refusal ends that run capped with the proxy's reason instead of a plan limit; no stream text decides it
- [ ] #2 Every old plan-limit case with no recorded proxy refusal still pauses the office as plan-limit, each with a test
- [ ] #3 Bypass forms have tests: the proxy's refusal text or a fake marker in worker output, a tool result or the report, a refusal recorded for another run and one recorded after the turn ended all still read as plan-limit
- [ ] #4 A fail-closed test runs the real model proxy and interpreter on a fixture-built office and shows an upstream 429 with no recorded refusal pauses the office
- [ ] #5 Every failed or cut-off audit and every failed session shows on the desk or in dipo ideas with its cause, not only in the daemon log
- [ ] #6 No view says blocked for a story that only waits for Ready; it shows Refined, not Ready yet, with its first gate failure
<!-- AC:END -->
