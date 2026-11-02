---
id: DIPO-428
title: 'Park a worker''s question at once, whichever client is connected'
status: Refined
assignee: []
created_date: '2026-11-02 12:11'
updated_date: '2026-11-02 12:12'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/records/live-question.ts
  - packages/engine/src/questions/permissions.ts
  - packages/engine/src/run/control.ts
  - packages/engine/src/records/caps.ts
  - packages/engine/src/config/schema.ts
  - packages/engine/schema/office.schema.json
  - packages/engine/src/create/core.ts
  - packages/engine/src/create/notify.ts
  - packages/engine/src/db/
  - packages/daemon/src/foreground.ts
  - packages/engine/test/
  - packages/daemon/src/
priority: medium
type: bug
ordinal: 406000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker's question parks the story at once, the same with a TUI open or not, so a TUI left open overnight never holds the office's worker place for 15 minutes.

Found by the M1 close-out review of 2026-11-02 at main 01f38a19. `questionRoute` returns `live` only while a TUI is connected (packages/engine/src/records/live-question.ts about lines 34-35), fed by the daemon (packages/daemon/src/foreground.ts about line 579). A live question keeps the worker waiting on stdin, holding the office's single worker place, for up to `timeouts.questionWaitMinutes` (15), left out of the minute cap (questions/permissions.ts, run/control.ts, records/caps.ts). That breaks 0001 (the engine never changes its behaviour by connected client) and 0020, which says a question parks at once and lists "a question wait that depended on a TUI being connected" as replaced.

Design (the maintainer's choice of 2026-11-02: park at once, as the ADRs say): remove the live route, the TUI presence input and `timeouts.questionWaitMinutes`; every question parks at once and is answered from the desk with resume (0020). An office.yaml that still sets the key loads with a notice that it is no longer read, as removed keys are handled today, or through the office config version rule if that is what dipo does for a removed key (0017). The question-wait records the engine no longer writes are dropped by a migration if nothing reads them. One question path (0001). 0001, 0020.

```dipo
branch: "DIPO-428/question-parks-at-once"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a worker question parks the story at once with or without a TUI connected; the live wait, TUI presence and questionWaitMinutes are gone"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A worker question parks the story at once with a TUI connected and without one, the same park record, shown by a test of each
- [ ] #2 The live question route, the TUI presence input to the engine and `timeouts.questionWaitMinutes` are removed, shown by the diff and a source scan test
- [ ] #3 An office.yaml that still sets `timeouts.questionWaitMinutes` loads and says the key is no longer read, shown by a config test
- [ ] #4 No ADR text changes: 0001 and 0020 already say this
<!-- AC:END -->
