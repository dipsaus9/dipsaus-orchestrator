---
id: DIPO-124
title: 'Refuse a malformed change-log entry when it is written, not on every replay'
status: To Do
assignee: []
created_date: '2026-10-16 13:05'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/changelog
  - packages/engine/test/changelog
  - packages/daemon/src/server.ts
  - packages/daemon/test
  - packages/client/src/client.ts
  - packages/client/test
priority: medium
type: feature
ordinal: 114000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a change-log entry whose delta does not match its event's data schema fails the transaction that writes it, so no stored entry can cut the office's clients off.

Context: NewEntry.delta is unknown (packages/engine/src/changelog/log.ts), and appendEntries checks only that the type exists (assertOfficeFactType). On replay, render throws RenderError for a bad delta; the daemon closes the stream with 1008 without advancing the cursor (packages/daemon/src/server.ts), and the client resubscribes from the same cursor (packages/client/src/client.ts), so every client of that office loops for good. The office store reloads only on stream.resetRequired. engine.notice entries are built by hand in about 24 files, and the only test checks that render throws. Found by the 2026-10-16 milestone review, section 1c CC1.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 appendEntries parses each entry's delta with findEvent(type).data and throws inside the writing transaction when it does not match; nothing is appended
- [ ] #2 A test writes a malformed engine.notice and sees the transaction fail with no change_log row and the cursor unchanged
- [ ] #3 Every existing writer passes the check (the full suite is green), and a test shows a replay of already-stored entries still renders
- [ ] #4 Decide and test what a client gets for a bad entry already stored by an older binary (skip with a notice, or stream.resetRequired), so it cannot loop
<!-- AC:END -->
