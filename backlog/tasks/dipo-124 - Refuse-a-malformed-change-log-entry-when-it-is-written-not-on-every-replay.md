---
id: DIPO-124
title: 'Refuse a malformed change-log entry when it is written, not on every replay'
status: Refined
assignee: []
created_date: '2026-10-16 13:05'
updated_date: '2026-10-22 18:16'
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
  - packages/engine/test/changelog
  - packages/daemon/src/server.ts
  - packages/daemon/test
  - packages/client/src/client.ts
  - packages/client/test
  - packages/engine/src
  - docs/decisions/0005-command-and-event-model.md
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
- [ ] #1 appendEntries validates what the renderer would send (findEvent(type).data.safeParse of the same delta and view merge renderDelta does, shared from changelog/render.ts) and throws inside the writing transaction when it fails; nothing is appended
- [ ] #2 Tests: a malformed engine.notice fails with no change_log row and the cursor unchanged; a story.state entry with its view passes
- [ ] #3 Every existing writer passes the check (the full suite is green); a writer the check exposes is fixed in this story; a replay of already-stored entries still renders
- [ ] #4 What a client gets for a bad entry already stored by an older binary is decided so it cannot loop, tested, and proposed as a dated note on 0005 section 8 in the PR for the maintainer's approval
<!-- AC:END -->
