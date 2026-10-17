---
id: DIPO-175
title: Scrub thinking text from stdout lines longer than the host's line cap
status: Done
assignee: []
created_date: '2026-10-17 17:00'
updated_date: '2026-10-17 21:07'
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
- [x] #1 No byte of a field the plan's lineScrub names (thinking text, signature) reaches events.ndjson from a stdout line longer than MAX_PENDING_LINE, whatever the field order in the line and wherever the piece boundaries fall
- [x] #2 The host's held text stays under a fixed cap stated in packages/engine/src/host/: a line that never ends still cannot grow the host's memory without limit
- [x] #3 A stdout line under the cap is stored as today: unchanged when the scrub removes nothing, scrubbed when it holds a scrubbed block type
- [x] #4 Tests in packages/engine/test/host/ cover a capped line with a thinking block whose text spans two pieces, a capped line whose block type field comes after the thinking text, a capped line with no thinking block, and a line under the cap
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M55TDXVYKHH6QE3VZPFWH6QH (Haiku low, 22 turns, about $0.02, 2 min) reported done. LineScrubber (host/scrub.ts) holds the splitter pieces of one stdout line until its newline and scrubs the joined line; WorkerHost #pump feeds every stdout piece through it. MAX_SCRUB_LINE is 16 Mi UTF-16 code units: a longer line is dropped up to its newline. Review: no reader breaks on the larger event lines (ingest reads a line over MAX_READ_BYTES whole; the host socket sends only offsets; the adapter already joined the old pieces). A line over 16 Mi used to be rebuilt from its pieces and is now dropped, so on the finish branch the drop is logged to host.log (warn 'dropped a stdout line over the scrub cap', with the held length); no stdout marker, which the adapter would only count as unparseable. Verify outside the sandbox on DIPO-175/scrub-capped-stdout-lines-finish: 3160 pass, 2 skip, 0 fail; DIPO_TEST_CI=1 host and ingest 122 pass. Inside the worker sandbox the worker overrode DIPO_TMP and saw 15 EPERM host failures (DIPO-184 now tells workers not to).
<!-- SECTION:NOTES:END -->
