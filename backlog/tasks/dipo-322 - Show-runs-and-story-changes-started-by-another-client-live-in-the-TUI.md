---
id: DIPO-322
title: Show runs and story changes started by another client live in the TUI
status: Done
assignee: []
created_date: '2026-10-23 08:11'
updated_date: '2026-10-23 10:29'
labels:
  - 'tier:M'
  - 'slice:m1b'
milestone: m-1
dependencies: []
references:
  - '- packages/client/src/store/'
  - packages/client/src/client.ts
  - packages/client/src/store/office-store.ts
  - packages/client/test/
  - packages/client/test/unit/fake-daemon.ts
  - packages/client/test/unit/live-updates.test.ts
  - packages/tui/src/
  - packages/tui/src/live.test.tsx
priority: medium
type: bug
ordinal: 307000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: when a run starts, moves or ends through another client (dipo run, dipo watch, the CLI of another terminal) or through dipo itself, the TUI's open office views (overview, queue, live agent, story detail) show it within a few seconds, without leaving and re-entering the office.

Context: in the box runs of 2026-10-22 and 2026-10-23 the maintainer saw that an open TUI did not update when runs were started or moved by this repository's maintainer session through the CLI; leaving the office and entering it again showed the current state. So the facts are stored, but the open view does not take the changes from the stream (the office store, the subscription after a reconnect, or the views' reaction to work and story events). The daemon was also restarted for new builds during that time, so the reconnect path is one candidate. 0009 sections 4 and 7 (the TUI follows the office stream; reconnect with backoff); 0005 (streams and cursors).

```dipo
branch: "DIPO-322/tui-live-updates"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) an office store fed work.assigned, work.phase, work.progress, work.output and story.state events from the stream updates the overview, the queue, the live agent view and the story detail without a new snapshot"
    - kind: "automated"
      check: "(unit) after a daemon restart and the client's reconnect, the store resubscribes after its last cursor and the next events update the open views"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The cause is named in the PR: why an open view does not take changes that the stream carries
- [x] #2 After a daemon restart the TUI reconnects, resubscribes after its last cursor and keeps updating live
- [x] #3 Tests cover events from another client and the reconnect
- [x] #4 An open TUI shows a run started, moved or ended by another client (the stream's work.assigned, work.phase, work.progress, work.output and story.state events) in the overview, the queue, the live agent view and the story detail within 5 seconds of the event
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Done 2026-10-23 (maintainer session): built outside dipo, reviewed by a separate agent (all 4 criteria met; 6 of the 8 new tests fail without the fix). Cause: after a daemon restart the client re-sends its office subscription while the daemon still recovers, the daemon refuses it with engine.recovering, and the office store subscribed again only on stream.resetRequired, so the open view froze until the office was entered again; a failed office switch also dropped the current office's events. The live 5-second check of criterion 4 is the maintainer's. Advisories filed as DIPO-327.
<!-- SECTION:NOTES:END -->
