---
id: DIPO-484
title: dipo names the real cause of every failure
status: Done
assignee: []
created_date: '2026-11-10 15:36'
updated_date: '2026-11-10 16:45'
labels:
  - 'tier:M'
milestone: m-3
dependencies: []
references:
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/src/box/model-proxy.ts
  - packages/engine/src/records/proxied-usage.ts
  - packages/engine/src/run/outcome-exits.ts
  - packages/engine/src/overview/chain.ts
  - packages/engine/src/overview/desk.ts
  - packages/contract/src/office.ts
  - packages/cli/src/ideas-command.ts
  - packages/tui/src/chain.ts
  - packages/tui/src/queue.tsx
  - packages/tui/src/desk.tsx
  - packages/tui/src/desk-preview.ts
modified_files:
  - packages/cli/src/ideas-command.test.ts
  - packages/contract/schema/reads.schema.json
  - packages/contract/schema/work.schema.json
  - packages/contract/src/office.ts
  - packages/engine/src/box/model-proxy.ts
  - packages/engine/src/db/migrations/0011-proxy-refusals.ts
  - packages/engine/src/db/schema.ts
  - packages/engine/src/overview/chain.ts
  - packages/engine/src/overview/desk.ts
  - packages/engine/src/records/proxied-usage.ts
  - packages/engine/src/records/proxy-refusals.ts
  - packages/engine/src/retention/policy.ts
  - packages/engine/src/retention/run.ts
  - packages/engine/src/run/audit-session.ts
  - packages/engine/src/run/control.ts
  - packages/engine/src/run/idea-audits.ts
  - packages/engine/src/run/outcome-exits.ts
  - packages/engine/src/run/outcome-turns.ts
  - packages/engine/src/run/outcome-types.ts
  - packages/engine/src/run/reviews.ts
  - packages/engine/src/run/session-run.ts
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/src/workers/claude-cli/result.ts
  - packages/engine/src/workers/claude-cli/schema.ts
  - packages/engine/src/workers/types.ts
  - packages/engine/test/box/model-proxy-count.test.ts
  - packages/engine/test/db/migrations.test.ts
  - packages/engine/test/overview/chain.test.ts
  - packages/engine/test/overview/desk.test.ts
  - packages/engine/test/run/audit-session.test.ts
  - packages/engine/test/run/ideas.test.ts
  - packages/engine/test/run/outcomes.test.ts
  - packages/engine/test/workers/interpret.test.ts
  - packages/engine/test/workers/result.test.ts
  - packages/tui/src/chain.test.ts
  - packages/tui/src/chain.ts
  - packages/tui/src/desk-preview.test.ts
  - packages/tui/src/desk-preview.ts
  - packages/tui/src/desk.test.tsx
  - packages/tui/src/desk.tsx
  - packages/tui/src/queue.test.tsx
  - packages/tui/src/queue.tsx
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
3. Stories that only wait for Ready read as blocked. No view prints the word for a Refined story; the places that make it look blocked are: the engine's chain gives a Refined dependency the state `waiting`, the same as a dependency that is itself waiting (`stateOf`, packages/engine/src/overview/chain.ts:18-24), and the TUI gives `waiting` no mark (`chainMark` and `markRole`, packages/tui/src/chain.ts:115-125); the Queue lists a Ready story whose dependency is only Refined under WAITING ON A DEPENDENCY (packages/tui/src/queue.tsx:24); and the Desk counts it in "blocks N" (packages/tui/src/desk.tsx:298, packages/tui/src/desk-preview.ts:81 and :220). The fix: the chain gets a `refined` state for a dependency that is Refined (the contract's `ChainState`, packages/contract/src/office.ts:874, gains the value), rendered "Refined, not Ready yet" with its first gate failure wherever a dependency shows (the Queue's needs column and preview, the Floor's UP NEXT, the Desk's blocks line), as the Queue's REFINED group does (queue.tsx:57-60). The maintainer then sees the wait is theirs to clear by setting it Ready.

Mechanism for 1 (one, 0001), taking up what DIPO-470 left out of scope ("a later 429 the proxy sends for a real cap is still read as the plan's limit by the interpreter"): the proxy records each refusal it sends in the engine, against the run, with its reason and time; the run's ending reads that record. The record is written where the proxy refuses a capped request, at `ModelUseCapped` (packages/engine/src/records/proxied-usage.ts:99), in the run's records; the run is the one the proxy knows by the sender's peer address (packages/engine/src/box/model-proxy.ts:18-23), never by a header or body. A 429 in a turn for which the engine recorded a proxy refusal ends the run capped with the proxy's reason; a 429 with no such record is the plan's limit, as today. The worker's stream never decides it: no header or body marker is read, since text in the stream is the worker's to write. This replaces "every 429 is the plan's limit".

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
      check: "(unit) office.chain gives a Refined dependency the state refined, not waiting; the Queue's needs column and preview, the Floor's UP NEXT and the Desk's blocks line show it as Refined, not Ready yet, with its first gate failure; a dependency that is itself waiting on another keeps waiting"
    - kind: "manual"
      check: "On the scratch repository, give a run a tiny token budget so the proxy refuses it, and look at the Desk, the Floor and dipo ideas"
      expect: "The run ends capped with the proxy's reason, the office is not paused, and no Refined story says blocked"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The model proxy records each refusal it sends in the run's records at ModelUseCapped, for the run its peer address names, and a 429 in a turn with a recorded refusal ends that run capped with the proxy's reason instead of a plan limit; no stream text decides it
- [x] #2 Every old plan-limit case with no recorded proxy refusal still pauses the office as plan-limit, each with a test
- [x] #3 Bypass forms have tests: the proxy's refusal text or a fake marker in worker output, a tool result or the report, a refusal recorded for another run and one recorded after the turn ended all still read as plan-limit
- [x] #4 A fail-closed test runs the real model proxy and interpreter on a fixture-built office and shows an upstream 429 with no recorded refusal pauses the office
- [x] #5 Every failed or cut-off audit and every failed session shows on the desk or in dipo ideas with its cause, not only in the daemon log
- [x] #6 office.chain gives a Refined dependency its own state refined instead of waiting (overview/chain.ts:18-24), and the Queue, the Floor and the Desk show it as Refined, not Ready yet, with its first gate failure
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-10 16:45 UTC
- Criteria met: 6 of 6 (as the worker reported them)
- Loops: 1; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 1, failed 0
- Budget used: 275,780 of 800,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 1
<!-- SECTION:FINAL_SUMMARY:END -->
