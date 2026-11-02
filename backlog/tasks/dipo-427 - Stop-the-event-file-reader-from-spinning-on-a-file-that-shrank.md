---
id: DIPO-427
title: Stop the event-file reader from spinning on a file that shrank
status: In Review
assignee: []
created_date: '2026-11-02 12:11'
updated_date: '2026-11-02 12:34'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/ingest/event-file.ts
  - packages/engine/src/ingest/ingestor.ts
  - packages/engine/test/ingest/
priority: medium
type: bug
ordinal: 405000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an event file that is truncated or replaced between its stat and its read never freezes the daemon.

Found by the M1 close-out review of 2026-11-02 at main 01f38a19. `readCompleteLines` (packages/engine/src/ingest/event-file.ts about lines 48-62): when the file holds fewer bytes than the `size` the caller's stat reported and those bytes hold no newline, the loop sets `length = size - from`, which it already was, and loops again with no await. The review ran it on a 3-byte file with size 100 and it did not return in 8 s. The caller stats the file and then reopens it by path (ingest/ingestor.ts about lines 412-419). A stuck loop stops every office, the socket and keep-awake. Same class as DIPO-422.

Design: a read that returns fewer bytes than asked ends the pass with no lines; the next pass sees the changed file. 0005.

```dipo
branch: "DIPO-427/event-file-short-read"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) readCompleteLines returns no lines when the file holds fewer bytes than its stat said, instead of looping"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `readCompleteLines` on a file shorter than the given size returns within a test timeout with no lines, shown by a test with a 3-byte file and size 100
- [x] #2 A file that grows between passes is still read in full on the next pass, shown by the existing tests
<!-- AC:END -->
