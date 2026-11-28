---
id: DIPO-527
title: 'Background: the engine lists everything it runs or waits on outside story runs'
status: Ready
assignee: []
created_date: '2026-11-28 14:11'
updated_date: '2026-11-28 16:50'
labels:
  - 'tier:M'
  - 'role:developer'
milestone: m-6
dependencies: []
references:
  - packages/contract/src/office.ts
  - packages/contract/src/work.ts
  - packages/engine/src/backlog/lane/progress.ts
  - packages/engine/src/run/audit-session.ts
  - docs/design/chat-and-activity/migration.md
priority: high
type: feature
ordinal: 488000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want dipo to tell me everything it is busy with besides the runs, open PRs and their CI included, so that no work happens out of my sight.

P5, engine side. `OfficeSnapshot.background`: story PRs after their run (CI state, attempt N of M, the scheduled retry, auto-merge, merged not yet closed), the lane's backlog PR (LaneProgress), open tests (TestView), the audit (held ideas, a running audit), the chat (answering, held message) and the daemon (an update built or refused with its reason, a recovery). Each item: kind, ref, subject, state (failed, needs-you, running, waiting, done), next (a code-built line, never an estimate: decision 24; a time dipo itself scheduled, such as `retry at 14:20`, is a fact and may show, per the maintainer's answer of 2026-11-28), since, url. The engine orders them failed, needs-you, running, waiting, done and drops a done item after 10 minutes. `background.changed` carries each state change with one ticker line. LaneProgress stays for the BACKLOG list it already feeds.

Design: docs/design/chat-and-activity/ (spec.md, The background; screens/03-floor-background.txt for the fields each row needs). The mocks win; a cell difference is a bug (DIPO-520).

```dipo
branch: "DIPO-527/background-list"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a story PR whose CI failed with attempts left lists as failed with next naming the retry time"
    - kind: "automated"
      check: "(unit) the lane's backlog PR lists with its CI and auto-merge"
    - kind: "automated"
      check: "(unit) a refused dipo update lists under the daemon with its reason"
    - kind: "automated"
      check: "(unit) a done item leaves the list after 10 minutes"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 OfficeSnapshot.background lists the six kinds with state, next, since and url where there is one
- [ ] #2 The engine sets the order and drops done items after 10 minutes
- [ ] #3 background.changed fires on every state change with its ticker line
- [ ] #4 Nothing in next is an estimate
<!-- AC:END -->
