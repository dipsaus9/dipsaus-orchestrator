---
id: DIPO-512
title: Read only whole lines in every daemon log reader of the integration tests
status: Parked
assignee: []
created_date: '2026-11-10 14:16'
updated_date: '2026-11-26 09:47'
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
unknowns:
  - q: "Test-plan entry 3 needs the DIPO_TEST_CI=1 integration tests to pass, and my instructions say not to set that variable in this box. May CI be the place that runs them, with this PR's report accepted on the strength of the CI run, or do you want me to set DIPO_TEST_CI=1 here for one run?"
    status: "resolved"
    answer: "Yes you are allowed this one time"
test_plan:
  entries:
    - kind: "automated"
      check: "The shared reader on a file whose last line has no newline returns only the complete lines, parsed"
    - kind: "automated"
      check: "The shared reader on a missing file returns no lines and does not throw"
    - kind: "automated"
      check: "The daemon integration tests pass in CI with the shared reader in every file named in the criteria"
park:
  reason: "ambiguous-spec"
  from: "In Progress"
  note: "The reconcile CI test (reconcile.ci.test.ts, \"loads and reconciles every registered office in recovering, before running\") fails in this box both with my change and on the untouched HEAD file: no \"office reconciled\" or \"reconcile failed\" line appears in the second start's log. Should this story be accepted with that failure recorded as pre-existing and handled in its own story, or should I investigate and fix it here before the story can be done?"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 One shared testkit function returns the parsed lines of a daemon log, leaving out a last line without a newline, and returns no lines when the file is missing.
- [ ] #2 drain, db-close, reconcile, reattach-kill and uncaught-error read the daemon log only through the shared function.
- [ ] #3 Every read of daemon.log in foreground.ci.test.ts that runs while the daemon may still write uses the shared function.
- [ ] #4 No test under packages/daemon/test/integration parses daemon log lines with its own split and JSON.parse while the daemon runs.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parked 2026-11-26 09:44 UTC: ambiguous-spec
- Detail: Test-plan entry 3 needs the DIPO_TEST_CI=1 integration tests to pass, and my instructions say not to set that variable in this box. May CI be the place that runs them, with this PR's report accepted…
- Run: run_01M8BKNA5W37K0TGSHD2E40PF9
- Criteria met: 4 of 4 (as the worker reported them)
- Loops: 1 of 3; CI attempts: 0 of 2
- Review rounds: 0, failed 0 of 3
- Budget used: 71,155 of 300,000 tokens; 28 of 90 turns; 3 of 45 minutes
- Last good commit: 8799607863f6e9af7645e7352c9a9bff0b768a09

Resumed 2026-11-26 09:44 UTC; grants: none; note: Yes you are allowed this one time

Parked 2026-11-26 09:47 UTC: ambiguous-spec
- Detail: The reconcile CI test (reconcile.ci.test.ts, "loads and reconciles every registered office in recovering, before running") fails in this box both with my change and on the untouched HEAD file: no "of…
- Run: run_01M8BKNA5W37K0TGSHD2E40PF9
- Criteria met: 4 of 4 (as the worker reported them)
- Loops: 1 of 3; CI attempts: 0 of 2
- Review rounds: 0, failed 0 of 3
- Budget used: 115,779 of 300,000 tokens; 40 of 90 turns; 5 of 45 minutes
- Last good commit: def975cc82cad830404b390d8a8b6933e6575372
<!-- SECTION:NOTES:END -->
