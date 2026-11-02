---
id: DIPO-423
title: Keep the local test suite's daemons off the real container CLI
status: Refined
assignee: []
created_date: '2026-11-02 10:09'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/client/test/integration/
  - packages/daemon/test/integration/
  - packages/testkit/src/
priority: medium
type: bug
ordinal: 401000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `bun run verify` never runs the real Apple `container` CLI except in the box tests (DIPO_TEST_BOX=1), so it cannot touch the maintainer's boxes or hang when the container apiserver hangs.

Found by the DIPO-419 builder on 2026-11-02: the daemons that packages/client/test/integration/daemon.test.ts and packages/daemon/test/integration/uncaught-error.test.ts start find /usr/local/bin/container and run it at daemon start. Before DIPO-419 their `TestBoxes.sweep` deleted every `dipo-tst_` box on the Mac, an open test's box of the real office included; DIPO-419 limits deletion to the state folder's own boxes, but the calls stay, and with the apiserver hung daemon.test.ts timed out on main.

Design: those test daemons get the fake box backend the unit tests use, unless DIPO_TEST_BOX=1; one switch for every test daemon (0001). 0008, 0017.

```dipo
branch: "DIPO-423/test-daemons-no-container"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(daemon, client) the integration tests' daemons start with a box backend that never runs the real container CLI unless DIPO_TEST_BOX=1"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every daemon the local test suite starts outside DIPO_TEST_BOX=1 runs no `container` command, shown by a test that puts a logging stand-in `container` first on PATH and finds it never called
- [ ] #2 With DIPO_TEST_BOX=1 the box tests still reach the real CLI, shown by the existing box tests
<!-- AC:END -->
