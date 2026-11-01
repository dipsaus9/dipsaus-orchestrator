---
id: DIPO-412
title: Deliver a maintainer steer to a running developer session
status: Done
assignee: []
created_date: '2026-11-01 15:39'
updated_date: '2026-11-01 18:44'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/run/intervene.ts
  - packages/engine/src/run/feedback.ts
  - packages/engine/src/run/hosts.ts
  - packages/engine/src/host/steering.ts
  - packages/engine/src/workers/claude-cli/
  - packages/engine/src/run/control.ts
  - packages/engine/test/run/
  - packages/engine/test/workers/
  - packages/engine/test/host/
priority: high
type: bug
ordinal: 390000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo steer <ID> "<text>"` on a running story always reaches the developer: in its running turn while the session lives, or in the next session's first message when the session ends first. The maintainer can see which happened.

Found in the M1 hand-test wave of 2026-11-01 on the scratch office (binary 9c7d41238fbc). Two of two steers were lost. TASK-11: steer at 14:44:07, the worker finished at 14:44:16 without the asked JSDoc. TASK-16: steer at 15:02:08, then a park; the resume carried only the resume note. In both runs the steer's `run_intents` row stayed `sent` and was never resolved, and `dipo steer` printed "the worker reads it with its next turn".

Today run/intervene.ts sends it through run/feedback.ts `sendFeedback`, which workers/claude-cli/encode.ts writes as one stream-json user message with priority `next` on the worker's stdin through the worker host (run/hosts.ts, host/steering.ts). Claude Code itself reads such a message (see the unknown), so the steer is lost between dipo and the session's stdin, inside or outside the box; the first step is to find where, with a test on a real host and box path. Design: the Claude adapter launches with `--replay-user-messages`, and a replayed user message carrying a steer's text marks that steer read. One delivery path for steers, held texts and answers (0001). 0008, 0020.

```dipo
branch: "DIPO-412/steer-reaches-worker"
unknowns:
  - q: "Does Claude Code read a priority-next stream-json user message sent during a turn, and can dipo see when it is read?"
    status: "resolved"
    answer: "Yes (live probe with Claude Code 2.1.316 and Haiku, 2026-11-01): a message sent 3 s into a Bash call was read right after the call finished, in the same turn, and with --replay-user-messages the stream echoed it then as a user event with isReplay true; the reply followed it. So the loss is on dipo's side, and the replayed message is how dipo sees a read."
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a steer sent during a running turn reaches the developer session, is marked read when the session replays it, and otherwise goes with the next session's first message"
    - kind: "manual"
      check: "(live) on the scratch office, start a tiny Ready story with dipo run --box and send dipo steer with an extra request a few seconds in"
      expect: "the PR carries the steered change and dipo watch shows the steer as read"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A steer sent during a running turn reaches the developer session's stdin through the real worker host (and box, when the run is boxed), shown by a test that finds where today's steers are lost and proves the fix there
- [x] #2 The Claude adapter launches with `--replay-user-messages`, and the replayed user message carrying a steer's text resolves that steer's intent as read, shown by a test on a stream-json fixture with a replayed message
- [x] #3 A steer still unread when its session ends goes with the run's next developer session's first message, and none stays `sent` after its run ends, shown by a test
- [x] #4 A steer on a story that is parked, or parks before the steer is read, reaches the resume's first message beside the resume note; `dipo steer` says which of these happens, shown by a test
<!-- AC:END -->
