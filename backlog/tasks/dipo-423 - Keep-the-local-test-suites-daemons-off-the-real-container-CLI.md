---
id: DIPO-423
title: Keep the local test suite's daemons off the real container CLI
status: Done
assignee: []
created_date: '2026-11-02 10:09'
updated_date: '2026-11-02 10:45'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/testkit/src/env.ts
  - packages/testkit/src/
  - packages/client/test/integration/
  - packages/daemon/test/integration/
modified_files:
  - packages/daemon/test/integration/box-cli.test.ts
  - packages/testkit/src/env.test.ts
  - packages/testkit/src/env.ts
priority: medium
type: bug
ordinal: 401000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `bun run verify` never runs the real Apple `container` CLI except in the box tests (DIPO_TEST_BOX=1), so it cannot touch the maintainer's boxes or hang when the container apiserver hangs.

Found by the DIPO-419 builder on 2026-11-02: the daemons that packages/client/test/integration/daemon.test.ts and packages/daemon/test/integration/uncaught-error.test.ts start find /usr/local/bin/container and run it at daemon start. Before DIPO-419 their `TestBoxes.sweep` deleted every `dipo-tst_` box on the Mac, an open test's box of the real office included; DIPO-419 limits deletion to the state folder's own boxes, but the calls stay, and with the apiserver hung daemon.test.ts timed out on main.

Design: the daemons are child processes, so the switch is their environment. `daemonTestEnv` in packages/testkit/src/env.ts, which every integration test daemon uses, drops each PATH directory that holds an executable named `container` unless DIPO_TEST_BOX=1; `boxBackend` (packages/engine/src/create/runs.ts, `containerOnPath`) then finds no CLI and the daemon runs with no box backend, which those tests accept. No test hook in production code; one switch for every test daemon (0001). 0008, 0017.

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
- [x] #1 `daemonTestEnv` drops every PATH directory holding `container` unless DIPO_TEST_BOX=1, shown by a unit test of packages/testkit/src/env.ts; and a daemon started through it past its start step, with a logging stand-in `container` first on the caller's PATH, never calls the stand-in, shown by a test in packages/daemon/test/integration/
- [x] #2 With DIPO_TEST_BOX=1 the box tests still reach the real CLI, shown by the existing box tests
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-02 10:45 UTC
- Criteria met: 2 of 2 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 1, failed 0
- Budget used: 52,594 of 300,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 0
<!-- SECTION:FINAL_SUMMARY:END -->
