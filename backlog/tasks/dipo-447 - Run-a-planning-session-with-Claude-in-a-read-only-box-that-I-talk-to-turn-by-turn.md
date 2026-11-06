---
id: DIPO-447
title: >-
  Run a planning session with Claude in a read-only box that I talk to turn by
  turn
status: In Progress
assignee: []
created_date: '2026-11-05 20:51'
updated_date: '2026-11-06 09:04'
labels:
  - 'tier:L'
milestone: m-3
dependencies: []
references:
  - packages/engine/src/workers/types.ts
  - packages/engine/src/workers/claude-cli/box-plan.ts
  - packages/engine/src/workers/claude-cli/tools.ts
  - packages/engine/src/box/workers.ts
  - packages/engine/src/box/review-box.ts
  - packages/engine/src/box/model-proxy.ts
  - packages/engine/src/run/watchdog.ts
  - packages/engine/src/run/session-run.ts
  - packages/engine/src/ingest/ingestor.ts
  - packages/engine/src/config/schema.ts
  - packages/contract/src/work.ts
  - packages/contract/src/office.ts
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0002-review-and-testing.md
priority: high
type: feature
ordinal: 420000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want dipo to run a planning session with Claude in a read-only box that I talk to turn by turn and that keeps going until I end it, so that planning no longer needs a separate Claude Code chat.

M3 (0022). The engine part of the planning session; DIPO-448 adds the decision record and fresh sessions, DIPO-449 the TUI view, DIPO-450 the filing.

To build on: the reviewer's box (packages/engine/src/run/review-launch.ts; packages/engine/src/box/workers.ts review and endReview; packages/engine/src/box/review-box.ts read-only staging, which stages a pushed head today, so the planning copy is the base branch's tree with the backlog); the tool sets in packages/engine/src/workers/claude-cli/tools.ts; the box plan in packages/engine/src/workers/claude-cli/box-plan.ts. Messages already reach a running session's stdin as stream-json user messages (steer: packages/engine/src/run/feedback.ts, packages/engine/src/host/steering.ts). Missing: a planning worker kind and its tool set (read, search, web search and fetch, nothing else); stdin kept open across turns (the scan session closes it at the first turn, packages/engine/src/run/session-run.ts); work events and live usage for a session with no story (WorkRef needs a story, packages/contract/src/work.ts; packages/engine/src/ingest/ingestor.ts); the model proxy counting a session that has no story and no run cap (0008); a watchdog that does not count waiting for the maintainer as stuck (packages/engine/src/run/watchdog.ts); commands for clients to start, message and end a session (packages/contract/src/office.ts). dipo gives the session, as text in its first message, the facts its kind needs: open drafts, the desk and recent runs (retro numbers come with DIPO-453). The planning model key is a schema default only and is not written into .dipo/office.yaml, so no re-pin is needed for it.

Built by dipo where it can (maintainer's choice, 2026-11-05); a builder agent takes over if dipo gets stuck.

```dipo
branch: "DIPO-447/planning-session-engine"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a planning session starts with a kind and a goal, in a box planned like the reviewer's with only reading and web tools, and the office's planning model, default Opus"
    - kind: "automated"
      check: "(unit) a second planning session in the same office is refused while one is open, and an open session holds no run slot"
    - kind: "automated"
      check: "(ci) with a scripted worker, three maintainer messages give three answers on one session, each streamed as events with usage, and the watchdog does not fire while it waits"
    - kind: "automated"
      check: "(unit) tools: a planning plan asking for Bash, Edit or Write is refused, an unknown kind gets no tools, and the review and session tool sets are unchanged"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A planning session starts with a kind (plan, refine or triage) and a goal through a command, and runs Claude in a box set up like the reviewer's: a read-only copy of the base branch's tree with the backlog, no mounts, the box firewall and web proxy, and only reading, search and web tools
- [ ] #2 The planning model is an office setting with default Opus, the model proxy counts the session's usage with no run cap, and the spend is reported live
- [ ] #3 An office has at most one open planning session, and it holds no run slot
- [ ] #4 Each maintainer message, sent by a command, reaches the open session as the next turn, and each answer is streamed as events a client can read, though the session has no story
- [ ] #5 The session's first message gives it, as text, the open drafts, the desk and recent runs
- [ ] #6 Waiting for the maintainer never trips the watchdog's quiet or stuck timers or a minute cap; an end command ends the session, and a session idle for a day ends by itself
- [ ] #7 The old barrier still catches what it caught: the review and session tool sets and the reviewer's box are unchanged, with tests
- [ ] #8 Bypass forms are tested: Bash, Edit or Write asked for through tool-name case or an alias, an extra MCP server, and allowed-tools text injected through the goal
- [ ] #9 A fail-closed test against the real path: the real adapter refuses a planning plan that asks for a writing tool, and an unknown session kind gets no tools
- [ ] #10 ADRs 0008 and 0002 name the planning session where they list session kinds, boxes, the model proxy and slots
<!-- AC:END -->
