---
id: DIPO-124
title: 'Refuse a malformed change-log entry when it is written, not on every replay'
status: Done
assignee: []
created_date: '2026-10-16 13:05'
updated_date: '2026-10-23 06:10'
labels:
  - 'tier:S'
milestone: m-1
dependencies:
  - DIPO-284
  - DIPO-285
  - DIPO-281
  - DIPO-288
  - DIPO-159
  - DIPO-290
  - DIPO-149
  - DIPO-292
  - DIPO-293
  - DIPO-294
  - DIPO-295
  - DIPO-296
  - DIPO-298
  - DIPO-301
  - DIPO-302
  - DIPO-303
  - DIPO-152
references:
  - '- packages/engine/test/changelog'
  - docs/decisions/0005-command-and-event-model.md
  - packages/client/src/client.ts
  - packages/client/test
  - packages/client/test/unit/client.test.ts
  - packages/daemon/src/server.ts
  - packages/daemon/test
  - packages/daemon/test/integration/server.test.ts
  - packages/engine/src
  - packages/engine/src/changelog/cursor.ts
  - packages/engine/src/changelog/log.ts
  - packages/engine/src/changelog/render.ts
  - packages/engine/src/index.ts
  - packages/engine/test/changelog/changelog.test.ts
  - packages/engine/test/retention/retention.test.ts
priority: medium
type: feature
ordinal: 114000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a change-log entry that would not render fails the transaction that writes it, so no newly stored entry can cut the office's clients off.

Context: NewEntry.delta is unknown (packages/engine/src/changelog/log.ts), and appendEntries checks only that the type exists (assertOfficeFactType). On replay, render throws RenderError for a bad entry; the daemon closes the stream with 1008 without advancing the cursor (packages/daemon/src/server.ts), and the client resubscribes from the same cursor (packages/client/src/client.ts), so every client of that office loops for good. The office store reloads only on stream.resetRequired. Writers store a story.state view in NewEntry.view, and renderDelta merges it into the delta only at render time. Handling a bad entry already stored changes 0005 section 8 (replay of stored facts, gap-free seqs, the meaning of stream.resetRequired). Found by the 2026-10-16 milestone review, section 1c CC1.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 appendEntries validates what the renderer would send (findEvent(type).data.safeParse of the same delta and view merge renderDelta does, shared from changelog/render.ts) and throws inside the writing transaction when it fails; nothing is appended
- [x] #2 Tests: a malformed engine.notice fails with no change_log row and the cursor unchanged; a story.state entry with its view passes
- [x] #3 Every existing writer passes the check (the full suite is green); a writer the check exposes is fixed in this story; a replay of already-stored entries still renders
- [x] #4 What a client gets for a bad entry already stored by an older binary is decided so it cannot loop, tested, and proposed as a dated note on 0005 section 8 in the PR for the maintainer's approval
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-22: built outside dipo, reviewed (pass; two fixes made). The client store does not reload on changelog.unrenderable yet (follow-up; fits DIPO-320's shared client store).
<!-- SECTION:NOTES:END -->
