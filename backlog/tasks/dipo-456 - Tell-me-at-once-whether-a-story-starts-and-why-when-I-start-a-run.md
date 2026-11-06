---
id: DIPO-456
title: Tell me at once whether a story starts and why when I start a run
status: Refined
assignee: []
created_date: '2026-11-06 09:49'
updated_date: '2026-11-06 09:52'
labels:
  - 'tier:S'
milestone: m-3
dependencies: []
references:
  - packages/engine/src/run/work-run.ts
  - packages/engine/src/run/next-up.ts
  - packages/engine/src/commands/registry.ts
  - packages/contract/src/office.ts
  - packages/tui/src/home.tsx
  - packages/tui/src/queue.test.tsx
priority: medium
type: feature
ordinal: 429000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want dipo to tell me within a second or two whether a story starts and why, when I press u in the TUI, run dipo run or confirm next up, so that I see at once what happens instead of waiting for the box to be set up.

M3 (maintainer's choice, 2026-11-06). Measured 2026-11-06: work.run answered after 122 s (first run after a fresh database: image build and package cache fill), then 17.6 s and 14.2 s; a refusal for a full office took 3.4 s. The handler (packages/engine/src/run/work-run.ts, a waiting office command, packages/engine/src/commands/registry.ts) answers only after the claim, the push, the box start and the install; the TUI (packages/tui/src/home.tsx runSelected) shows "being sent; wait for its reply" until then, and next-up confirm (packages/engine/src/run/next-up.ts) waits the same way.

The fix: work.run answers as soon as dipo has decided, with each story started or skipped and its reason, as its result already lists (packages/contract/src/office.ts); the claim, push, box start and install go on after the answer, shown as the run's phase (setup) as the overview already does, and a failure after the answer parks the story or posts a notice as today. A refusal answers without a fetch when the decision needs none (a full office). One mechanism: work.run and next-up confirm are no longer registered as waiting office commands (addAsyncOfficeCommand), and no client waits for setup; the shared waiting registration stays for its other commands (merge, questions, discard, intervene, planning, proposals). The waits in packages/tui/src/queue.test.tsx change with it.

Built by dipo where it can (maintainer's choice, 2026-11-05); a builder agent takes over if dipo gets stuck.

```dipo
branch: "DIPO-456/answer-run-at-decision"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) work.run answers with started and skipped stories and their reasons before the claim, push and box start finish, and the run then shows phase setup"
    - kind: "automated"
      check: "(unit) a claim or box failure after the answer parks the story or posts a notice, as before"
    - kind: "automated"
      check: "(unit) work.run and next-up confirm are registered as non-waiting, and the TUI queue no longer shows being sent, wait for its reply past the answer"
    - kind: "automated"
      check: "(unit) a full office answers its capacity skip without a fetch; next-up confirm answers the same way"
    - kind: "manual"
      check: "On the scratch repository with a Haiku office, press u on a Ready story in the TUI queue"
      expect: "the footer says the story starts, or why not, within about 2 seconds, and the overview shows it in setup"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 work.run answers as soon as dipo has decided, with each story started or skipped and its reason
- [ ] #2 The claim, push, box start and install go on after the answer, shown as the run's setup phase, and a failure after the answer parks the story or posts a notice
- [ ] #3 A refusal that needs no fetch, such as a full office, answers without one
- [ ] #4 Next-up confirm answers the same way
- [ ] #5 work.run and next-up confirm are not registered as waiting office commands and no client waits for setup to finish, while the shared waiting registration stays for its other commands
<!-- AC:END -->
