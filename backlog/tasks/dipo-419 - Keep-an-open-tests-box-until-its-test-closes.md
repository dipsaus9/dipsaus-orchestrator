---
id: DIPO-419
title: Keep an open test's box until its test closes
status: Refined
assignee: []
created_date: '2026-11-02 09:14'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/box/workers.ts
  - packages/engine/src/box/test-box.ts
  - packages/engine/src/run/tests.ts
  - packages/engine/test/box/
  - packages/engine/test/run/
priority: medium
type: bug
ordinal: 397000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the box of an open test stays until dipo closes the test, so `dipo test shell <ID>` always reaches it; when dipo deletes any box, the daemon log says which and why.

Found in the TUI hand test of 2026-11-02 on the scratch office (binary ca71ee54, story TASK-19 flagged test-before-merge, a product with nothing to start). The first test, tst_01M6DQGRGD7XT01J4QT5CB1C2P, logged "box ready" at 08:55:21 and "the install in the box passed" at 08:55:25, and `test.start` answered ok at 08:55:26. About half a minute later `dipo test shell TASK-19` failed with "get failed: container dipo-tst_01M6DQGRGD7XT01J4QT5CB1C2P not found", and `container list --all` no longer listed it. The test row stayed open (ended_at null), and at `test.record` (08:57:58) deleting the box warned notFound. Nothing in the daemon log says who deleted it. The second and third tests of the same story kept their boxes (the second for at least three minutes), so the cause is not every test box. The Safe-Chain box started at 08:55:22, during the first test's start. Box deletions in packages/engine/src/box/workers.ts that log nothing on success include `#finish` (`this.#deps.boxes.delete(box)` after `#checked`). A test box is made through the same `workers.create` with the test id as its run id (box/test-box.ts), so a pass that treats boxes by run id may take it for an ended run's box.

Find the deleter and make the test box exempt in the one place that decides which boxes go (0001), as `close()` already exempts test boxes at daemon stop. 0008, 0013.

```dipo
branch: "DIPO-419/keep-open-test-box"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a test box of an open test survives every box tick and sweep until the test is recorded or closed, and every deletion of a box is logged"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The cause is named in the PR: which code deleted the first test's box while its test was open
- [ ] #2 A test box whose test is open is never deleted by a box tick, sweep or run finish; it goes only when its test closes (record, new head, drop, discard, merge, idle timeout) or at recovery when its test is gone, shown by a test that runs the deleting path with an open test
- [ ] #3 Every box deletion dipo makes logs the box and the reason at info, shown by a test
<!-- AC:END -->
