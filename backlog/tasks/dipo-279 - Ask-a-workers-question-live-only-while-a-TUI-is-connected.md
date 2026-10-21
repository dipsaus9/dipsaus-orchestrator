---
id: DIPO-279
title: Ask a worker's question live only while a TUI is connected
status: Done
assignee: []
created_date: '2026-10-21 13:45'
updated_date: '2026-10-21 14:35'
labels:
  - 'tier:S'
  - cutover
  - box
milestone: m-1
dependencies: []
references:
  - packages/engine/src/hooks/questions.ts
  - packages/engine/src/hooks/permissions.ts
  - packages/engine/test/hooks/
  - packages/engine/src/run/live-question.ts
  - packages/engine/test/run/live-question.test.ts
  - packages/engine/src/hooks/index.ts
  - packages/engine/test/run/park-resume.test.ts
  - packages/engine/test/run/park-resume.ci.test.ts
  - packages/engine/test/run/temp-dirs.ci.test.ts
  - packages/daemon/src/server.ts
  - packages/daemon/src/foreground.ts
  - packages/daemon/test/integration/presence.test.ts
  - packages/contract/src/software.ts
  - packages/cli/src/tui-command.ts
priority: high
type: feature
ordinal: 268000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker's question is shown live only while a TUI is connected at that moment; otherwise the story parks with the question at once (0020 amendment of 2026-10-21).

Context: Decision 0021 (worker isolation, DIPO-263) and the probe results of DIPO-264 (tools/box-probe/RESULTS.md and the 0021 amendment of 2026-10-21).

```dipo
branch: "DIPO-279/live-questions-tui-open"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The live path checks for a connected TUI at the moment of the question, not a 10-minute activity window
- [x] #2 Without a connected TUI the story parks with the question
- [x] #3 Tests cover both paths
- [x] #4 The rule is one engine function in packages/engine/src/run/live-question.ts that every question source calls, so the door questions of DIPO-272 use it too
<!-- AC:END -->
