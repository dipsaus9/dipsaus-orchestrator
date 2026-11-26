---
id: DIPO-512
title: Read only whole lines in every daemon log reader of the integration tests
status: Ready
assignee: []
created_date: '2026-11-10 14:16'
updated_date: '2026-11-17 14:49'
labels:
  - tech-debt
  - 'tier:S'
  - 'role:developer'
milestone: m-4
dependencies: []
references:
  - packages/daemon/test/integration/drain.ci.test.ts
  - packages/daemon/test/integration/reconcile.ci.test.ts
  - packages/daemon/test/integration/reattach-kill.ci.test.ts
  - packages/daemon/test/integration/uncaught-error.ci.test.ts
  - packages/testkit/src/env.ts
  - packages/daemon/test/integration/db-close.ci.test.ts
  - packages/daemon/test/integration/foreground.ci.test.ts
type: chore
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want every integration test that reads a running daemon's log to skip a line still being written so that CI never fails on a half-written log line.

uncaught-error.ci.test.ts reads only complete lines: it splits on newlines and drops the last piece, which has no newline yet (packages/daemon/test/integration/uncaught-error.ci.test.ts:48-57). The other readers parse a line the daemon may still be writing:
- drain.ci.test.ts:21-29 and db-close.ci.test.ts:27-35 trim the file and JSON.parse every line.
- reconcile.ci.test.ts:38-43 does the same, and throws if the file is missing.
- reattach-kill.ci.test.ts:117-124 keeps every line that starts with {, which a half-written line does too.
- foreground.ci.test.ts reads daemon.log at :168, :271, :371 and :493 and parses lines from it.

- One shared reader in packages/testkit (next to daemonTestEnv, packages/testkit/src/env.ts) returns the parsed complete lines of a daemon log, and none when the file is missing.
- Every reader above uses it. A test that reads the log after the daemon has exited may keep reading the whole file.

## What it does not do
- Does not change how the daemon writes its log.
- Does not change what any test asserts about the log, only how it reads it.

## ADR lines that change
None.

## Risks and choices
None.

```dipo
branch: "DIPO-512/read-only-whole-lines-every-daemon-log"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "The shared reader on a file whose last line has no newline returns only the complete lines, parsed"
    - kind: "automated"
      check: "The shared reader on a missing file returns no lines and does not throw"
    - kind: "automated"
      check: "The daemon integration tests pass in CI with the shared reader in every file named in the criteria"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 One shared testkit function returns the parsed lines of a daemon log, leaving out a last line without a newline, and returns no lines when the file is missing.
- [ ] #2 drain, db-close, reconcile, reattach-kill and uncaught-error read the daemon log only through the shared function.
- [ ] #3 Every read of daemon.log in foreground.ci.test.ts that runs while the daemon may still write uses the shared function.
- [ ] #4 No test under packages/daemon/test/integration parses daemon log lines with its own split and JSON.parse while the daemon runs.
<!-- AC:END -->
