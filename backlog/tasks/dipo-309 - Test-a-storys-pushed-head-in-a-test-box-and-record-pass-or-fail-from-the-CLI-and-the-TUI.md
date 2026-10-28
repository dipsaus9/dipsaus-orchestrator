---
id: DIPO-309
title: >-
  Test a story's pushed head in a test box and record pass or fail from the CLI
  and the TUI
status: Refined
assignee: []
created_date: '2026-10-22 20:56'
updated_date: '2026-10-28 13:44'
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

The first step found on 2026-10-28 that the Mac does not reach a box address the normal way while the GlobalProtect VPN is on (it routes 192.168.128.0/24 through its tunnel; only connections bound to the box bridge work), and that the box firewall drops the box's replies to the Mac. The maintainer then chose a forwarder on the Mac's loopback (Q6 below). The TUI checklist view moved to DIPO-365. This story changes a firewall rule, so its criteria name what the old rule caught, the bypass forms and a fail-closed test against the real path (CLAUDE.md, R30).

```dipo
branch: "DIPO-309/test-story-box"
unknowns:
  - q: "Q5. Where the product runs for a test: a new test box from the pushed head, the builder's kept box, or on the Mac."
    status: "resolved"
    answer: "A new test box per test, from the story branch's pushed head (what the reviewer read and CI ran), with the office image, the listed files, install from the package cache through Safe-Chain, and dev started by dipo. It leaves the builder's box untouched. Accepted risk, the same as testing by hand: the page dev serves runs in the maintainer's browser on the Mac. (maintainer, 2026-10-22: accepted the recommended answers)"
  - q: "Q6. How the Mac reaches dev inside the box: an in-box forwarder on the box address, a published port on the Mac's loopback, or a HOST variable added to the script standard."
    status: "resolved"
    answer: "dipo runs a forwarder on the Mac that listens on 127.0.0.1 on a free port and forwards to the dev port at the test box's address, connecting through the box bridge, so it works with a VPN on. The URL is http://localhost:<port>. No container port is published and repositories need no change. If dev listens only on the box's loopback, the smallest in-box relay from the box address to that port is added. The test box alone gets a firewall rule for replies to connections the Mac opened. (maintainer, 2026-10-28, replacing the in-box forwarder on the box address of 2026-10-22, which failed with the VPN on)"
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
      check: "(unit, fake box) test.start creates a new test box from the pushed head with its own local git repository and only the listed files, installs, runs setup, starts dev, takes the first URL within the start timeout, starts the Mac loopback forwarder to the box, publishes no container port, and replies with the steps, URL, box name, shell line and test id; a nothing-to-start product gets no dev"
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
      check: "(box) the test box answers the Mac forwarder's connection to its dev port, and still opens no new connection to the Mac or any address beyond dipo's proxies; each bypass form is refused"
    - kind: "automated"
      check: "(box) fail-closed: without the reply rule or with the forwarder stopped, the URL fails and nothing else becomes reachable"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `test.start` and `test.record` are registered (no longer provisional); `test.start` refuses a story with no manual test-plan entry (`story.notTestable`), a story that is not In Review in phase `review`, `test` or `merge` (new code `test.notInReview`), and an office whose install or `dev` is unresolved, after the fingerprint check with scan trigger `test`, naming the capability to fix; flagged and unflagged stories can both be tested
- [ ] #2 `test.start` creates a new test box per test from the story branch's pushed head, with the office image, its own local git repository made by `git init` like every box (0008) and only the files the office config lists, installs with the office install command through Safe-Chain and the package cache, runs `setup`, and starts `dev`; the builder's box is left untouched; a product marked as having nothing to start gets no `dev`
- [ ] #3 dipo runs a forwarder on the Mac: it listens on 127.0.0.1 on a free port and forwards to the `dev` port at the test box's address through the box bridge, the port taken from the first URL `dev` prints within the start timeout; if `dev` listens only on the box's loopback, the smallest in-box relay from the box address to that port is added; no container port is published, the test URL is http://localhost:<port>, and it works while a VPN routes the box network's range
- [ ] #4 The reply carries the test id, the manual steps (check and expected result, in order), `checkout` as the test box's name, and the optional `url` and `shell` (the `dipo test shell <ID>` line); `test.started` is emitted and the test shows in `office.snapshot`
- [ ] #5 `test.record` stores the result and note in `acceptance_tests` for the head it tested; a pass decides the story's `test` gate for the current head, after which the merge gate no longer waits on the flag for that head; an unflagged story's result shows in the merge gate summary and the PR status block; a pass on an older head than the story's current head is refused with `test.closed`
- [ ] #6 A fail starts a fix round through the one feedback path (0002 section 5) with the note as the item, sent once and keyed on the test id with no cap, to the same builder; a fail or a new head reopens the `test` gate, and after any new head a flagged story needs a new test, which the desk and the merge gate summary say
- [ ] #7 Each story has at most one open test, and several stories can each have one in its own box; the test's box and process stop and are deleted when the test is recorded, when a new head is pushed, when the story is dropped, discarded or merged, and when the new office timeout `timeouts.testIdleMinutes` (optional, default 240, added without a version bump; DIPO-353 keeps it in version 14) passes with no record; a daemon restart keeps open tests, and reconcile at daemon start deletes test boxes with no open test
- [ ] #8 `dipo test <ID>` prints the URL, the test box name, the numbered steps and the test id; `dipo test pass <ID> [--note <text>]` and `dipo test fail <ID> --note <text>` record it (fail without `--note` is refused); `dipo test shell <ID>` opens an interactive shell in the test box; the desk row of a story waiting on its test offers `dipo test <ID>`
- [ ] #9 Only the test box gets a firewall rule that lets it answer connections the Mac's bridge address opened to its `dev` port; what the old rule caught still fails, each with a test: a test box opening a new connection to the Mac, the local network or the internet outside dipo's proxies, and a developer or reviewer box answering or reaching anything outside dipo's proxies
- [ ] #10 The bypass forms are tested: a reply-shaped packet with no connection the Mac opened, a connection from the test box to the forwarder's Mac port, another box reaching the test box's `dev` port, and a second port the product opens in the test box
- [ ] #11 A fail-closed test against the real path: with the reply rule missing, or the forwarder stopped, the test URL fails and nothing else becomes reachable; `tools/box-probe/probe.sh` runs again for a test box, and ADR 0008 is rewritten for the Mac forwarder with one line in its Replaced list
<!-- AC:END -->
