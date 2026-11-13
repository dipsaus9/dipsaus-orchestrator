---
id: DIPO-489
title: >-
  A planning session hands over only at a full context and continues the
  conversation
status: Refined
assignee: []
created_date: '2026-11-13 09:09'
updated_date: '2026-11-13 09:29'
labels:
  - 'tier:M'
milestone: m-3
dependencies: []
references:
  - packages/engine/src/records/usage.ts
  - packages/engine/src/run/planning-session.ts
  - packages/engine/src/records/planning-record.ts
  - packages/engine/src/ingest/ingestor.ts
  - packages/engine/src/records/proxied-usage.ts
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/src/prompts/task/planning.md
  - packages/contract/src/work.ts
  - packages/engine/test/run/planning-world.ts
  - packages/engine/test/run/planning-record.test.ts
  - packages/engine/test/run/planning-session.test.ts
  - docs/decisions/0022-planning-sessions.md
priority: high
type: bug
ordinal: 461000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want a planning session to hand over to a fresh model session only when its context is really near full, and the fresh session to pick up the conversation where it stopped, so that a long planning session never throws away the exchange I was in the middle of.

M3 (0022), a bug from the maintainer's M4 planning hand test on 2026-11-12. At 13:36:52, 7 s after a message that followed an 8-minute pause, the session ended its model session `context-full` and started a fresh one (new box at 13:36:58, no WARN line). The maintainer: "The output was gone all of sudden." The session was nowhere near a full context. Split from the handover bug with DIPO-490 (the TUI side: one transcript per session); this story is the engine side, and DIPO-490 builds on its record.

1. The wrong measure. `contextNearFull` (packages/engine/src/records/usage.ts:719-728) sums input + output + cache creation of the agent's usage totals. That is spend over the whole model session, not the context's size: each prompt-cache expiry (5 minutes) writes the whole prefix again as cache creation and adds about one context to the sum, so a few pauses trip `PLANNING_CONTEXT_TOKENS = 150_000` (packages/engine/src/run/planning-session.ts:210; the trip in `#turnEnded`, :1792-1808). It is worse in a box: the totals there are the model proxy's count of every request the box made (packages/engine/src/records/proxied-usage.ts:1-4; the stream's own counts are skipped, packages/engine/src/ingest/ingestor.ts:484-489), subagents and helper calls included. The fix: the context size is the last main-agent message's input + cache read + cache creation + output, read from the worker stream's per-message usage (packages/engine/src/workers/claude-cli/interpret.ts:1010-1040, where a subagent message carries its `agentId`), with messages of subagents left out. A planning session runs in a box, so its `usage` events are `proxied` and the ingestor stores none of them (ingestor.ts:484-489); the size is therefore kept where every event already passes, the planning session's own ingestor hook `onWorkerEvents` (planning-session.ts:1724-1739): a `usage` event with no `agentId` sets the session's last context size on its `Open` state, proxied or not, and `#turnEnded` compares that value with the limit. It is not read from the usage tables. After a daemon restart the value starts empty, which is right: the model session continues as a fresh one anyway. A compaction still counts as full. `contextNearFull` has one caller (planning-session.ts:1798), so the cumulative sum is removed, not kept beside the new measure (0001).
2. The fresh session starts blind. Its first message (`planningRecordText`, packages/engine/src/records/planning-record.ts:220-241, used at planning-session.ts:1564-1569) holds the goal, the confirmed choices, the filed stories and the open questions, but not what the maintainer said, not the model's last answer and no word that it continues a session. The record's entry kinds (`PlanningEntryKind`, planning-record.ts:12) have no message. The fix: the record also keeps each maintainer message (a `planning.message` text, and the answers of a question block as they were sent) with its time, its run and the byte offset of that run's output when it was sent, and the model's last answer of each model session; the fresh session's first message says it continues the session and carries the last maintainer message and the last answer after the record's sections.
3. No notice. `continuedAt` (packages/contract/src/work.ts:791-793) is never set by `#viewOf` (planning-session.ts:2014-2068), so the TUI's "continued in a fresh model session" line (packages/tui/src/planning.tsx:694-695) never shows, and no log line says a handover happened. The fix: the view of a continued session carries `continuedAt`; each handover logs one INFO line with the office, the previous run, the new run, the reason and, for `context-full`, the measured context size.

Replaces: the cumulative token sum as the context measure, and a first message built from the record's decisions alone. The maintainer's messages are not story facts, so keeping them in the planning record does not touch the backlog as source of truth; they are retained as the record's other entries are.

Not a guard: no deny rule, sandbox setting or permission check changes (R30 does not apply).

ADR 0022 section 1, the line "**The decision record.**" (line 18): it names what the record keeps (adds the maintainer's messages and the last answer), says the context counts as near full when the last main-agent message's context reaches the limit or the session compacted, and that the fresh session's first message carries the last exchange and says it continues. The TUI sentence of that line is DIPO-490's.

Tier M: one measure replaced, two record entry kinds, the first message and the notice.

```dipo
branch: "DIPO-489/planning-handover-measure-and-record"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit, planning-world) a session whose cumulative usage passes the limit through three cache rewrites, but whose last main-agent message's input + cache read + cache creation + output stays under it, does not hand over; one whose last main-agent message reaches the limit hands over context-full"
    - kind: "automated"
      check: "(unit) a subagent message (with an agentId) over the limit does not count; a compaction still counts as full; contextNearFull's cumulative sum no longer exists"
    - kind: "automated"
      check: "(unit, planning-world, boxed) in a box session whose usage events are all proxied: true and stored nowhere, a last main-agent message under the limit does not hand over and one at the limit hands over context-full"
    - kind: "automated"
      check: "(unit, planning-record) a planning.message, a question answer and an answer end add message and answer entries with time, run and output offset; planningRecordText renders the last maintainer message and the last answer and the continue line"
    - kind: "automated"
      check: "(unit, planning-world) after a context-full handover the fresh session's first message says it continues the session and holds the last maintainer message and the previous model session's last answer"
    - kind: "automated"
      check: "(unit, planning-world) the view of a continued session carries continuedAt, and the handover logs one INFO line with office, previous run, new run, reason and the measured size"
    - kind: "manual"
      check: "On the scratch repository, run a planning session with three exchanges, each after a 6-minute pause, then end its model session by a daemon restart and send planning.continue; ask the fresh session what was said last"
      expect: "No context-full handover after the pauses; after the continue the fresh session names the last message and answer, the head shows the continued line and the daemon log has one INFO handover line"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A planning model session hands over context-full only when its last main-agent message's input + cache read + cache creation + output reaches the limit, or when it compacted; subagent messages and prompt-cache rewrites after a pause do not count
- [ ] #2 The cumulative token sum in contextNearFull is removed; one context measure remains
- [ ] #3 The planning record keeps each maintainer message (a planning.message text and the sent answers of a question block) with its time, run and output offset, and the model's last answer of each model session
- [ ] #4 A fresh model session's first message says it continues the session and carries the last maintainer message and the previous model session's last answer
- [ ] #5 The view of a continued session carries continuedAt, and each handover logs one INFO line with office, previous run, new run, reason and, for context-full, the measured size
- [ ] #6 ADR 0022's decision-record line says what the record keeps, how a near-full context is measured and that the fresh session continues the last exchange
<!-- AC:END -->
