---
id: DIPO-309
title: >-
  Test a story's pushed head in a test box and record pass or fail from the CLI
  and the TUI
status: Refined
assignee: []
created_date: '2026-10-22 20:56'
updated_date: '2026-10-22 20:56'
labels:
  - 'tier:L'
  - 'slice:m1b'
milestone: m-1
dependencies:
  - DIPO-308
  - DIPO-150
  - DIPO-240
references:
  - packages/contract/src/
  - packages/contract/schema/
  - packages/engine/src/box/
  - packages/engine/test/box/
  - packages/engine/src/run/
  - packages/engine/test/run/
  - packages/engine/src/scan/
  - packages/engine/src/views/
  - packages/engine/test/views/
  - packages/engine/src/reconcile/
  - packages/engine/src/merge-slot/
  - packages/engine/src/config/
  - packages/engine/test/config/
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/src/retention/policy.ts
  - packages/engine/src/reads/hello.ts
  - packages/cli/src/
  - packages/tui/src/
priority: high
type: feature
ordinal: 294000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the maintainer runs one command on a story in review and gets the product of the pushed head running in a box with its manual test steps beside it; their pass is recorded as the story's test, and a fail with a note sends the story back to its builder as feedback.

Context: follows 0011 item 8 and the vision (testing a story is a command: check out, install, start, show the test script; the pass or fail note feeds the next worker), 0002 (flagged stories wait until the maintainer has tested), 0005 section 4 (`test.start`, `test.record`, `story.notTestable`, `test.closed`), 0007 section 4 (gate kind `test`, table `acceptance_tests`), 0009 section 4 (the testing checklist view `4` and the desk `TEST` row) and section 5 (`t`, `P`, `F`; a fail needs a note), 0010 section 8 (run environment, `PORT`), 0012 F13, F14 and R21, the 0012 amendment of 2026-10-10 from 0016 (a flagged story needs a new test after its code changed), 0013 section 2 (the test command refuses when install or `dev` is unresolved) and section 5 (fingerprint check before the test command, scan trigger `test`), 0019 section 8 (the maintainer-reject row: note verbatim, keyed on the gate, no cap), section 11 ("for a flagged story this is the failed test until M1b's `test.record` takes over") and section 17, and 0021 sections 2, 3, 6 and 14 with the amendment of 2026-10-22 (dipo never runs a tool unboxed on files the worker wrote; install happens in the box through Safe-Chain and the package cache). Because of 0021 section 14 the story's code is not installed and started on the Mac. The box backend today never publishes ports (`packages/engine/src/box/apple-args.ts`).

The maintainer answered this story's questions on 2026-10-22 by accepting the recommended answers. They are in the unknowns below and in the 0005, 0013, 0017, 0019 and 0021 amendments of that day. Accepted risk, the same as testing by hand: the page `dev` serves runs in the maintainer's browser on the Mac.

First step: before building the forwarder path, check that the Mac reaches a box address on the host-only network; if it does not, stop and report the facts.

```dipo
branch: "DIPO-309/test-story-box"
unknowns:
  - q: "Q5. Where the product runs for a test: a new test box from the pushed head, the builder's kept box, or on the Mac."
    status: "resolved"
    answer: "A new test box per test, from the story branch's pushed head (what the reviewer read and CI ran), with the office image, the listed files, install from the package cache through Safe-Chain, and dev started by dipo. It leaves the builder's box untouched. Accepted risk, the same as testing by hand: the page dev serves runs in the maintainer's browser on the Mac. (maintainer, 2026-10-22: accepted the recommended answers)"
  - q: "Q6. How the Mac reaches dev inside the box: an in-box forwarder on the box address, a published port on the Mac's loopback, or a HOST variable added to the script standard."
    status: "resolved"
    answer: "dipo starts a small forwarder that is part of the box image inside the test box. It listens on the box's network address and forwards to the dev port on the box's loopback. The URL is the box address on the host-only network. No port is published and repositories need no change. The story's first step checks that the Mac reaches a box address on that network, and stops with the facts if it does not. (maintainer, 2026-10-22: accepted the recommended answers)"
  - q: "Q7. Which stories can be tested: In Review only, flagged only, or also Parked stories with a pushed head."
    status: "resolved"
    answer: "A story In Review (phase review, test or merge) with at least one manual test-plan entry, flagged or not. For an unflagged story the result is recorded and shown in the merge gate summary and the PR status block. Any other status is refused with a new code test.notInReview. (maintainer, 2026-10-22: accepted the recommended answers)"
  - q: "Q8. What a pass does to the merge gate of a flagged story."
    status: "resolved"
    answer: "A pass decides the story's test gate for the current head, by the maintainer. The merge gate then no longer counts the flag for that head. With mergeSlot.autoMerge on and no other reason from 0019 section 11, the story merges by rule; 0002 says a flagged story waits until it is tested, so the pass is the human's merge decision. A fail or a new head reopens the test gate. (maintainer, 2026-10-22: accepted the recommended answers)"
  - q: "Q9. How long a test stays open, and how many tests may be open at once."
    status: "resolved"
    answer: "One open test per story, several stories at once allowed (each in its own box). A test stays open until it is recorded, a new head is pushed, the story is dropped, discarded or merged, or a new office timeout timeouts.testIdleMinutes (default 240) passes with no record. A daemon restart keeps open tests and deletes test boxes with no open test. (maintainer, 2026-10-22: accepted the recommended answers)"
  - q: "Q10. The CLI form of the test command."
    status: "resolved"
    answer: "dipo test <ID> starts it and prints the URL, the code location, the numbered steps and the test id; dipo test pass <ID> [--note <text>] and dipo test fail <ID> --note <text> record it; dipo test shell <ID> opens an interactive shell in the test box, for products with nothing to start. (maintainer, 2026-10-22: accepted the recommended answers)"
  - q: "Q11. What the reply's checkout field means when the code lives in a box."
    status: "resolved"
    answer: "checkout is the test box's name, and the reply gains optional url and shell (the dipo test shell <ID> line), as minor contract additions. Reading the code stays with the PR on the host. (maintainer, 2026-10-22: accepted the recommended answers)"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) test.start refuses a story with no manual entry, a story that is not In Review with test.notInReview, and an office with install or dev unresolved, each with its error code and the capability named"
    - kind: "automated"
      check: "(unit, fake box) test.start creates a new test box from the pushed head without .git and only the listed files, installs, runs setup, starts dev with PORT set, starts the forwarder on the box address, takes the first URL within the start timeout, publishes no port, and replies with the steps, URL, box name, shell line and test id; a nothing-to-start product gets no dev"
    - kind: "automated"
      check: "(unit) a pass decides the test gate for its head, and with mergeSlot.autoMerge on and no other wait reason a flagged story merges by rule; an unflagged story's result shows in the merge gate summary; a pass on an older head is refused with test.closed"
    - kind: "automated"
      check: "(unit) a fail sends the note once as a fix round item keyed on the test id to the same builder, and after a new head a flagged story's merge gate waits for a new test"
    - kind: "automated"
      check: "(unit, fake box, manual clock) the test box is deleted on record, new head, drop, discard, merge and after timeouts.testIdleMinutes with no record; two stories can each have an open test; reconcile deletes a test box with no open test"
    - kind: "automated"
      check: "(unit) the office config accepts timeouts.testIdleMinutes at the new version, with default 240"
    - kind: "automated"
      check: "(unit, cli) dipo test prints the URL, box name, steps and test id; dipo test pass and dipo test fail send test.record; fail without --note is refused; dipo test shell opens a shell in the test box"
    - kind: "automated"
      check: "(unit, TUI harness) view 4 shows the steps, P sends a pass, F pre-fills the note with the first unticked step and sends a fail, and Esc leaves the test open"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `test.start` and `test.record` are registered (no longer provisional) under the `test.sessions` flag; `test.start` refuses a story with no manual test-plan entry (`story.notTestable`), a story that is not In Review in phase `review`, `test` or `merge` (new code `test.notInReview`), and an office whose install or `dev` is unresolved, after the fingerprint check with scan trigger `test`, naming the capability to fix; flagged and unflagged stories can both be tested
- [ ] #2 `test.start` creates a new test box per test from the story branch's pushed head, with the office image, no `.git` and only the files the office config lists, installs with the office install command through Safe-Chain and the package cache, runs `setup`, and starts `dev` with `PORT` set; the builder's box is left untouched; a product marked as having nothing to start gets no `dev`
- [ ] #3 dipo starts a small forwarder, part of the box image, in the test box: it listens on the box's network address and forwards to the `dev` port on the box's loopback, taken from the first URL `dev` prints within the start timeout; no port is published, and the test URL is the box address on the host-only network
- [ ] #4 The reply carries the test id, the manual steps (check and expected result, in order), `checkout` as the test box's name, and the optional `url` and `shell` (the `dipo test shell <ID>` line) as minor contract additions; `test.started` is emitted and the test shows in `office.snapshot`
- [ ] #5 `test.record` stores the result and note in `acceptance_tests` for the head it tested; a pass decides the story's `test` gate for the current head, after which the merge gate no longer counts the flag for that head, and with `mergeSlot.autoMerge` on and no other reason from 0019 section 11 the story merges by rule; an unflagged story's result shows in the merge gate summary and the PR status block; a pass on an older head than the story's current head is refused with `test.closed`
- [ ] #6 A fail starts a fix round with the note as the item, sent once and keyed on the test id with no cap (0019 section 8, maintainer-reject row), to the same builder; a fail or a new head reopens the `test` gate, and after any new head a flagged story needs a new test, which the desk and the merge gate summary say
- [ ] #7 Each story has at most one open test, and several stories can each have one in its own box; the test's box and process stop and are deleted when the test is recorded, when a new head is pushed, when the story is dropped, discarded or merged, and when the new office timeout `timeouts.testIdleMinutes` (default 240, at the next office configuration version) passes with no record; a daemon restart keeps open tests, and reconcile at daemon start deletes test boxes with no open test
- [ ] #8 `dipo test <ID>` prints the URL, the test box name, the numbered steps and the test id; `dipo test pass <ID> [--note <text>]` and `dipo test fail <ID> --note <text>` record it (fail without `--note` is refused); `dipo test shell <ID>` opens an interactive shell in the test box; the desk row of a story waiting on its test offers `dipo test <ID>`
- [ ] #9 The TUI checklist view `4` (and `t` on a desk row) shows the steps with local ticks, `P` passes, `F` fails with the note pre-filled with the first unticked step, and Esc leaves the test open
<!-- AC:END -->
