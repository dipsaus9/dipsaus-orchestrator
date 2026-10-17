---
id: DIPO-175
title: Scrub thinking text from stdout lines longer than the host's line cap
status: Refined
assignee: []
created_date: '2026-10-17 17:00'
updated_date: '2026-10-17 17:00'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/host/
  - packages/engine/test/host/
priority: medium
type: bug
ordinal: 164000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: no thinking text or signature reaches events.ndjson, also from a worker stdout line longer than the host's 4 MiB line cap.

Context: finding 15 of the DIPO-115 cutover, a follow-up from the PR #160 review (DIPO-105). LineSplitter (packages/engine/src/host/events.ts) emits a line longer than MAX_PENDING_LINE (4 MiB) as pieces of that size, each its own event. scrubLine (packages/engine/src/host/scrub.ts) returns a piece that is not JSON unchanged, so in that case a thinking text or signature reaches events.ndjson, against the 0007 section 8 guarantee. The field that marks a thinking block can sit in a different piece than its text, and JSON gives no field order. Options: hold the pieces of one capped line up to a second fixed cap and scrub them as one line, or redact every piece of a capped stdout line once the scrub is on.

```dipo
branch: "DIPO-175/scrub-capped-stdout-lines"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the host writes no thinking text or signature from a 5 MiB stdout line with a thinking block, in either field order"
    - kind: "automated"
      check: "(unit) a line under the cap and a capped line without a thinking block are stored as they are today"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 No byte of a field the plan's lineScrub names (thinking text, signature) reaches events.ndjson from a stdout line longer than MAX_PENDING_LINE, whatever the field order in the line and wherever the piece boundaries fall
- [ ] #2 The host's held text stays under a fixed cap stated in packages/engine/src/host/: a line that never ends still cannot grow the host's memory without limit
- [ ] #3 A stdout line under the cap is stored as today: unchanged when the scrub removes nothing, scrubbed when it holds a scrubbed block type
- [ ] #4 Tests in packages/engine/test/host/ cover a capped line with a thinking block whose text spans two pieces, a capped line whose block type field comes after the thinking text, a capped line with no thinking block, and a line under the cap
<!-- AC:END -->
