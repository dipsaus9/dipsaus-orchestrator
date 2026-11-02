---
id: DIPO-428
title: 'Park a worker''s question at once, whichever client is connected'
status: Ready
assignee: []
created_date: '2026-11-02 12:11'
updated_date: '2026-11-02 12:25'
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
  - packages/engine/src/config/load.ts
  - packages/engine/src/config/
  - packages/engine/schema/office.schema.json
  - packages/engine/src/create/core.ts
  - packages/engine/src/create/notify.ts
  - packages/engine/src/create/create-engine.ts
  - packages/engine/src/create/deps.ts
  - packages/engine/src/db/
  - packages/daemon/src/foreground.ts
  - packages/daemon/src/server.ts
  - packages/engine/test/
  - packages/daemon/src/
  - packages/daemon/test/
priority: medium
type: bug
ordinal: 406000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker's question parks the story at once, the same with a TUI open or not, so a TUI left open overnight never holds the office's worker place for 15 minutes.

Found by the M1 close-out review of 2026-11-02 at main 01f38a19. `questionRoute` returns `live` only while a TUI is connected (packages/engine/src/records/live-question.ts about lines 34-35), fed by the daemon (packages/daemon/src/foreground.ts about line 579, daemon/src/server.ts) through `TuiPresence` (create/notify.ts, create/create-engine.ts `setTuiPresent`, create/deps.ts, create/core.ts). A live question keeps the worker waiting on stdin, holding the office's single worker place, for up to `timeouts.questionWaitMinutes` (15; config/schema.ts about lines 262 and 692, schema/office.schema.json, questions/permissions.ts about lines 238, 268 and 282), left out of the minute cap (run/control.ts, records/caps.ts; migration 0050 `question-waits`). That breaks 0001 (the engine never changes its behaviour by connected client) and 0020, which says a question parks at once and lists "a question wait that depended on a TUI being connected" as replaced.

Design (the maintainer's choice of 2026-11-02: park at once, as the ADRs say): remove the live route, `TuiPresence` and all its plumbing (nothing else reads it), and `timeouts.questionWaitMinutes`; every question parks at once and is answered from the desk with resume (0020). Removing a key changes the office config's shape, so, as 0017 says, the office config version goes to 15 with a pure migration from 14 that drops the key, tested on fixture files; a version 14 file still loads (migrated in memory), and `dipo config migrate` rewrites it. The question-wait rows the engine no longer writes are dropped by a database migration if nothing reads them. One question path (0001). 0001, 0017, 0020.

```dipo
branch: "DIPO-428/question-parks-at-once"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a worker question parks the story at once with or without a TUI connected; the live route, TuiPresence and timeouts.questionWaitMinutes are gone"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A worker question parks the story at once with a TUI connected and without one, the same park record, shown by a test of each
- [ ] #2 The live question route, `TuiPresence` with its daemon and engine plumbing, and `timeouts.questionWaitMinutes` are removed, shown by the diff and a source scan test that finds none of the three names
- [ ] #3 The office config version is 15 with a migration from 14 that drops `timeouts.questionWaitMinutes`: a version 14 file that sets it loads, and `dipo config migrate` writes version 15 without it, shown by config tests on fixture files; the regenerated office.schema.json has no such key
- [ ] #4 No ADR text changes: 0001 and 0020 already say this
<!-- AC:END -->
