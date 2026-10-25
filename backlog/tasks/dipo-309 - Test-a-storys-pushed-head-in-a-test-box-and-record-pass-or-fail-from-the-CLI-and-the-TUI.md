---
id: DIPO-309
title: >-
  Test a story's pushed head in a test box and record pass or fail from the CLI
  and the TUI
status: Refined
assignee: []
created_date: '2026-10-22 20:56'
updated_date: '2026-10-25 09:55'
labels:
  - 'tier:L'
  - 'slice:m1b'
  - 'track:1'
milestone: m-1
dependencies:
  - DIPO-308
  - DIPO-150
  - DIPO-240
  - DIPO-345
  - DIPO-346
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

Context: the test step of 0002 section 9 and the vision (testing a story is a command: start the product, show the test script; the pass or fail note feeds the next worker), the test commands of 0005 (`test.start`, `test.record`, `story.notTestable`, `test.closed`), the gate kind `test` and the table `acceptance_tests` of 0007, the checklist view `4`, the desk `TEST` row and the keys `t`, `P` and `F` of 0009 (a fail needs a note), the script standard of 0013 (the test command refuses while install or `dev` is unresolved, a fingerprint check runs first with scan trigger `test`, and the scan records the dev port), and the box of 0008 (dipo never runs a tool on the Mac on files a worker wrote, so the story's code is not installed or started on the Mac; install goes through Safe-Chain and the package cache). The box backend today never publishes ports (`packages/engine/src/box/apple-args.ts`).

Reworded on 2026-10-25 for the simplified architecture: the test box has its own local git repository like every box (0008, DIPO-346), a pass decides the test gate and the merge itself is GitHub auto-merge after the merge gate (0002 section 8), a fail is a fix round on the one feedback path (0002 section 5, DIPO-345), and there are no port slots.

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
    answer: "A pass decides the story's test gate for the current head, by the maintainer. The merge gate then no longer counts the flag for that head. Since 2026-10-25 the merge itself is GitHub auto-merge once the merge gate is approved (0002 section 8); 0002 says a flagged story waits until it is tested, so the pass is the human's merge decision. A fail or a new head reopens the test gate. (maintainer, 2026-10-22: accepted the recommended answers)"
  - q: "Q9. How long a test stays open, and how many tests may be open at once."
    status: "resolved"
    answer: "One open test per story, several stories at once allowed (each in its own box). A test stays open until it is recorded, a new head is pushed, the story is dropped, discarded or merged, or a new office timeout timeouts.testIdleMinutes (default 240) passes with no record. A daemon restart keeps open tests and deletes test boxes with no open test. (maintainer, 2026-10-22: accepted the recommended answers)"
  - q: "Q10. The CLI form of the test command."
    status: "resolved"
    answer: "dipo test <ID> starts it and prints the URL, the code location, the numbered steps and the test id; dipo test pass <ID> [--note <text>] and dipo test fail <ID> --note <text> record it; dipo test shell <ID> opens an interactive shell in the test box, for products with nothing to start. (maintainer, 2026-10-22: accepted the recommended answers)"
  - q: "Q11. What the reply's checkout field means when the code lives in a box."
    status: "resolved"
    answer: "checkout is the test box's name, and the reply gains optional url and shell (the dipo test shell <ID> line). Reading the code stays with the PR on the host. (maintainer, 2026-10-22: accepted the recommended answers)"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) test.start refuses a story with no manual entry, a story that is not In Review with test.notInReview, and an office with install or dev unresolved, each with its error code and the capability named"
    - kind: "automated"
      check: "(unit, fake box) test.start creates a new test box from the pushed head with its own local git repository and only the listed files, installs, runs setup, starts dev, starts the forwarder on the box address, takes the first URL within the start timeout, publishes no port, and replies with the steps, URL, box name, shell line and test id; a nothing-to-start product gets no dev"
    - kind: "automated"
      check: "(unit) a pass decides the test gate for its head, and a flagged story's merge gate no longer waits on the flag for that head; an unflagged story's result shows in the merge gate summary; a pass on an older head is refused with test.closed"
    - kind: "automated"
      check: "(unit) a fail sends the note once as a fix round item through the one feedback path, keyed on the test id to the same builder, and after a new head a flagged story's merge gate waits for a new test"
    - kind: "automated"
      check: "(unit, fake box, manual clock) the test box is deleted on record, new head, drop, discard, merge and after timeouts.testIdleMinutes with no record; two stories can each have an open test; reconcile deletes a test box with no open test"
    - kind: "automated"
      check: "(unit) the office config accepts the optional timeouts.testIdleMinutes with default 240 and no version bump"
    - kind: "automated"
      check: "(unit, cli) dipo test prints the URL, box name, steps and test id; dipo test pass and dipo test fail send test.record; fail without --note is refused; dipo test shell opens a shell in the test box"
    - kind: "automated"
      check: "(unit, TUI harness) view 4 shows the steps, P sends a pass, F pre-fills the note with the first unticked step and sends a fail, and Esc leaves the test open"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `test.start` and `test.record` are registered (no longer provisional); `test.start` refuses a story with no manual test-plan entry (`story.notTestable`), a story that is not In Review in phase `review`, `test` or `merge` (new code `test.notInReview`), and an office whose install or `dev` is unresolved, after the fingerprint check with scan trigger `test`, naming the capability to fix; flagged and unflagged stories can both be tested
- [ ] #2 `test.start` creates a new test box per test from the story branch's pushed head, with the office image, its own local git repository made by `git init` like every box (0008) and only the files the office config lists, installs with the office install command through Safe-Chain and the package cache, runs `setup`, and starts `dev`; the builder's box is left untouched; a product marked as having nothing to start gets no `dev`
- [ ] #3 dipo starts a small forwarder, part of the box image, in the test box: it listens on the box's network address and forwards to the `dev` port on the box's loopback, taken from the first URL `dev` prints within the start timeout; no port is published, and the test URL is the box address on the host-only network
- [ ] #4 The reply carries the test id, the manual steps (check and expected result, in order), `checkout` as the test box's name, and the optional `url` and `shell` (the `dipo test shell <ID>` line); `test.started` is emitted and the test shows in `office.snapshot`
- [ ] #5 `test.record` stores the result and note in `acceptance_tests` for the head it tested; a pass decides the story's `test` gate for the current head, after which the merge gate no longer waits on the flag for that head; an unflagged story's result shows in the merge gate summary and the PR status block; a pass on an older head than the story's current head is refused with `test.closed`
- [ ] #6 A fail starts a fix round through the one feedback path (0002 section 5) with the note as the item, sent once and keyed on the test id with no cap, to the same builder; a fail or a new head reopens the `test` gate, and after any new head a flagged story needs a new test, which the desk and the merge gate summary say
- [ ] #7 Each story has at most one open test, and several stories can each have one in its own box; the test's box and process stop and are deleted when the test is recorded, when a new head is pushed, when the story is dropped, discarded or merged, and when the new office timeout `timeouts.testIdleMinutes` (optional, default 240, added without a version bump; DIPO-353 keeps it in version 14) passes with no record; a daemon restart keeps open tests, and reconcile at daemon start deletes test boxes with no open test
- [ ] #8 `dipo test <ID>` prints the URL, the test box name, the numbered steps and the test id; `dipo test pass <ID> [--note <text>]` and `dipo test fail <ID> --note <text>` record it (fail without `--note` is refused); `dipo test shell <ID>` opens an interactive shell in the test box; the desk row of a story waiting on its test offers `dipo test <ID>`
- [ ] #9 The TUI checklist view `4` (and `t` on a desk row) shows the steps with local ticks, `P` passes, `F` fails with the note pre-filled with the first unticked step, and Esc leaves the test open
<!-- AC:END -->
