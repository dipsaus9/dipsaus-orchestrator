---
id: DIPO-327
title: Back off the TUI store's stream retries and show a stream error in the TUI
status: Refined
assignee: []
created_date: '2026-10-23 10:28'
updated_date: '2026-10-28 15:05'
labels:
  - follow-up
  - 'slice:prune'
  - 'track:2'
  - 'tier:M'
milestone: m-1
dependencies:
  - DIPO-351
references:
  - packages/client/src/store/office-store.ts
  - packages/client/test/
  - packages/tui/src/
priority: low
type: task
ordinal: 312000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the TUI's stream retries back off instead of re-subscribing every 250 ms, a stream error that does not retry shows in the header, and the stream-reset desk test is stable.

Follow-up of the DIPO-322 review (advisories). The office store re-subscribes every 250 ms while the daemon answers engine.recovering, with no backoff; the software stream has no retry timer of its own; the TUI never shows the store's state.error, so a stream that ended for good only reads catching up.

The TUI desk test "reads it again after a stream reset" (packages/tui/src/desk.test.tsx) failed now and then in full runs on 2026-10-28 and passed on its own; it waits on the same stream retry.

```dipo
branch: "DIPO-327/tui-stream-backoff"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the office stream retry backs off from 250 ms to 5 s and resets on running or reconnect"
    - kind: "automated"
      check: "(unit, TUI harness) a stream error that does not retry shows in the header, and the stream-reset desk test passes in 20 runs in a row"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The office stream retry backs off from 250 ms to at most 5 s and resets on daemon.state running or a reconnect
- [ ] #2 A software stream that ends with a retryable error is subscribed again on the same backoff
- [ ] #3 The TUI shows a stream error that does not retry in its header, and a render test of the story detail checks it updates after a restart
- [ ] #4 The TUI desk test that reads the desk again after a stream reset waits on the store's state rather than on time, and passes in 20 full-suite runs in a row
<!-- AC:END -->
