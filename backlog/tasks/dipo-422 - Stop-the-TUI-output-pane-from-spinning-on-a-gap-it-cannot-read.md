---
id: DIPO-422
title: Stop the TUI output pane from spinning on a gap it cannot read
status: In Review
assignee: []
created_date: '2026-11-02 10:09'
updated_date: '2026-11-02 10:29'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/tui/src/output.ts
  - packages/tui/src/output.test.ts
  - packages/tui/src/live.test.tsx
priority: high
type: bug
ordinal: 400000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an output pane that misses bytes it cannot read back shows a one-line gap note and goes on with the live output; it never loops.

Found by the DIPO-421 builder on 2026-11-02: two `bun test packages/tui/src/live.test.tsx` processes ran at full CPU for about 30 minutes and made the maintainer's Mac slow. In packages/tui/src/output.ts `#apply` queues a range whose `from` is past the held end and calls `#fill`; `#readOn` returns at once when the read comes back empty, `#drain` applies the same range again, and the cycle repeats with no timer, so it spins as long as the gap cannot be read (output dipo did not store, a trimmed or retained range, or a test daemon that never stored it). The live run's own output can hit it as well as a test.

Design: after one read that does not reach the range's `from`, the pane shows one line `[N bytes of output not stored]` (N = from − held end) and applies the range from its `from`, moving the held end to the range's end, so the next range is not seen as another gap. The gap line is a pane line outside the held text, like a marker, so it never reads as worker output and the byte offsets of the held text stay true. One gap-fill path (0001). 0009.

```dipo
branch: "DIPO-422/output-gap-no-spin"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(TUI) a work.output range past the held end whose gap a read cannot fill is shown after a gap line, once, with no read loop"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A work.output range whose gap one read cannot fill makes the pane show the single line `[N bytes of output not stored]` with the missing byte count, outside the held text, and then the range's text; the next range continues from that range's end with no second gap, shown by a test whose read returns empty
- [x] #2 The pane reads the gap at most once per missed range: a test counts the reads and fails if a second one starts without a new range
- [x] #3 A gap the read does fill shows the read text and no gap line, as now, shown by the existing tests
<!-- AC:END -->
