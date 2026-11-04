---
id: DIPO-439
title: 'Run several stories at once, each in its own box, up to a limit per office'
status: Refined
assignee: []
created_date: '2026-11-04 12:24'
updated_date: '2026-11-04 13:59'
labels:
  - 'tier:L'
milestone: m-2
dependencies: []
references:
  - packages/engine/src/run/work-run.ts
  - packages/engine/src/run-state/places.ts
  - packages/engine/src/config/schema.ts
  - packages/contract/src/office.ts
  - packages/contract/schema/config.schema.json
  - packages/contract/schema/commands.schema.json
  - packages/contract/src/work.ts
  - packages/engine/test/run/work-run.test.ts
  - packages/engine/test/run/work-run.ci.test.ts
  - packages/engine/test/run-state/places.test.ts
  - docs/decisions/0002-review-and-testing.md
  - docs/decisions/0010-backlog-and-git-integration.md
priority: high
type: feature
ordinal: 412000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want dipo to run several stories at the same time, each in its own box, up to a limit I set per office, so that more of the backlog gets done while I am away.

M2 goal (0003, maintainer's planning interview 2026-11-04). Blocks M2.

Today one office runs one story at a time on purpose:
- work.run refuses maxAgents above 1 with "refused until M2" (packages/engine/src/run/work-run.ts, around line 351).
- Calls are serialised per office through the #busy chain, "one run per office at a time" (work-run.ts around 326-345).
- Each office has one worker place and one reviewer place (packages/engine/src/run-state/places.ts), and a pickup is skipped as capacity when the place is taken or after the first start in one call.

The change: an office setting sets how many stories may run at once, default 3 (maintainer's choice). Each running story gets its own worker place and its own reviewer place. The maxAgents argument goes; the office setting is the one limit (one mechanism per goal, 0001). Reopened runs (resume, fix, conflict, review) that wait in Places.drain count against the same limit. Shared parts stay shared: the per-office git queue (packages/engine/src/git/queue.ts), the box network with its web route and Safe-Chain box, the model proxy, the image build and the package cache already handle several boxes.

How a free slot gets its next story is DIPO-440; this story only makes room for several runs and lets `dipo run <id>` start a story while others run. The capacity comment in packages/contract/src/work.ts names maxAgents and changes with it. The new office.yaml key means the pinned dipo binary is rebuilt right after merge, before the next run.

Built by builder agents: it changes dipo's own run path.

```dipo
branch: "DIPO-439/run-several-stories-at-once"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) places.test.ts: an office with limit 3 holds three worker places and three reviewer places; a fourth pickup is skipped as capacity naming the limit"
    - kind: "automated"
      check: "(unit) work-run.test.ts: dipo run of a second story while one runs starts it; at the limit it is refused with the limit in the message"
    - kind: "automated"
      check: "(ci) work-run.ci.test.ts: two stories with scripted workers run at once and both reach In Review with their own pull requests"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An office setting sets how many stories run at the same time; its default is 3 and the office config schema documents it
- [ ] #2 dipo run of a story starts it while other stories of the office run, as long as the number of running stories stays under the limit
- [ ] #3 At the limit a start is refused or skipped as capacity, with a message that names the limit and the setting
- [ ] #4 Each running story has its own worker place and its own reviewer place, so one story's review never waits for another story's worker
- [ ] #5 Waiting reopened runs (resume, fix, conflict and review rounds) count against the same limit and restart when a slot frees up
- [ ] #6 The maxAgents argument and its M2 refusal are removed; the office setting is the only limit
- [ ] #7 ADRs 0002 and 0010 describe several runs at once and the office limit where they now describe one run per office; the two-lanes text in 0002 changes only when dipo runs in parallel on itself
<!-- AC:END -->
