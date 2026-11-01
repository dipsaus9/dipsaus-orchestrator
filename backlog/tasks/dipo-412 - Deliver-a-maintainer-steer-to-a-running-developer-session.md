---
id: DIPO-412
title: Deliver a maintainer steer to a running developer session
status: Refined
assignee: []
created_date: '2026-11-01 15:39'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/run/intervene.ts
  - packages/engine/src/run/feedback.ts
  - packages/engine/src/workers/claude-cli/encode.ts
  - packages/engine/src/run/control.ts
  - packages/engine/test/run/
  - packages/engine/test/workers/
priority: high
type: bug
ordinal: 390000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo steer <ID> "<text>"` on a running story always reaches the developer: in its next turn while the session lives, or in the next session's first message when the session ends first. The maintainer can see which happened.

Found in the M1 hand-test wave of 2026-11-01 on the scratch office (binary 9c7d41238fbc). Two of two steers were lost. TASK-11: steer at 14:44:07, the worker finished at 14:44:16 without the asked JSDoc. TASK-16: steer at 15:02:08, then a park; the resume carried only the resume note. In both runs the steer's `run_intents` row stayed `sent` and was never resolved, and `dipo steer` printed "the worker reads it with its next turn".

Today run/intervene.ts sends it through run/feedback.ts `sendFeedback`, which workers/claude-cli/encode.ts writes as one stream-json user message with priority `next` on the worker's stdin. Not yet known: whether Claude Code (2.1.316 on the host) reads a `next` message that arrives during a turn, or whether the run ends at the turn's result before the session reads stdin. The first step is to find which, from a recorded stream-json session; the fix keeps one delivery path for steers, held texts and answers (0001). 0008, 0020.

```dipo
branch: "DIPO-412/steer-reaches-worker"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a steer sent during a running turn reaches the developer session as its next user message, or waits for the next session, and its intent is resolved"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A steer sent during a running turn reaches the developer session: its events show the steer text as a user message and the session's next turn follows it, shown by a test on a recorded Claude Code stream-json session; the maintainer's next hand-test wave checks it live
- [ ] #2 A steer the session has not read when its turn ends does not get lost: the session takes it as its next turn, or, when the session ends, the run's next developer session gets it in its first message, shown by a test
- [ ] #3 A steer's intent is resolved when a session reads it, and none stays `sent` after its run ends; `dipo steer` says what happens to the text, shown by a test
- [ ] #4 A steer on a story that is parked, or parks before the steer is read, reaches the resume's first message beside the resume note, shown by a test
<!-- AC:END -->
