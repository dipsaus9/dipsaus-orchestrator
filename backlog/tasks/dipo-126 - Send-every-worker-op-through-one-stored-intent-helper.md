---
id: DIPO-126
title: Send every worker op through one stored-intent helper
status: Done
assignee: []
created_date: '2026-10-16 13:06'
updated_date: '2026-10-17 17:52'
labels:
  - 'tier:M'
milestone: m-1
dependencies:
  - DIPO-123
references:
  - packages/engine/src/run
  - packages/engine/src/hooks/nudges.ts
  - packages/engine/src/hooks/permissions.ts
  - packages/engine/test/run
  - packages/engine/test/hooks
  - docs/decisions/0008-worker-adapter.md
  - packages/engine/src/db/migrations
  - packages/engine/src/db/schema.ts
priority: medium
type: task
ordinal: 116000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the 0008 rule that every op sent to a running worker is stored as an intent first lives in one helper, and every op either goes through it or is a written exception.

Context: packages/engine/src/run/intents.ts says every op the engine sends to a running worker is stored as pending before it is sent (0008 sections 6 and 7, DIPO-50). recordIntent is called at several sites in run/control.ts, run/outcomes.ts and run/reattach.ts; some store, send and mark by hand, some only record, and the copies have drifted. Three ops are sent with no intent: closeStdin in run/control.ts, nudges in hooks/nudges.ts and hook replies in hooks/permissions.ts. DIPO-123 changes the act() failure path in the same code, so this follows it. Found by the 2026-10-16 milestone review, section 1c CC5.

```dipo
branch: "DIPO-126/one-stored-intent-helper"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the helper stores, sends and marks an intent; a failed store sends nothing and a failed send marks the intent failed"
    - kind: "automated"
      check: "(unit) each listed exception (closeStdin, nudges, hook replies) behaves as its intents.ts header says, and a new intent kind has its migration and outcomeOfIntent test"
    - kind: "automated"
      check: "(unit) the existing run and hook tests pass unchanged"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 One function in run/intents.ts (for example sendAsIntent(office, runId, kind, detail, op)) stores the intent, sends, and marks it sent or failed; every site that stores, sends and marks today uses it with unchanged behaviour, and record-only sites (stored and marked in one transaction with no send, as in run/outcomes.ts) stay as they are, listed in the PR
- [x] #2 closeStdin, nudges and hook replies each either go through it or are listed as exceptions with their reason in the intents.ts header; a new intent kind comes with a migration (run_intents.kind has a CHECK constraint) and an outcomeOfIntent test; if an exception changes what 0008 says, a dated 0008 note is proposed in the PR for the maintainer's approval
- [x] #3 Tests cover a failed store (no op sent), a failed send (intent marked failed) and each exception
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Proposed 0008 note (needs the maintainer's approval, not applied):

- 2026-10-17, DIPO-126 (maintainer): section 6. Three ops are sent with no intent, because none of them explains an exit, so section 7 would never read one: the `closeStdin` after a turn whose report ended the run (report `done`; the exit is read from the report, the first row of the section 7 table, not from an engine decision); a 0014 nudge (it answers a pending `PostToolUse` or `SessionStart` hook call, section 5 and the DIPO-60 notes); and a `PermissionRequest` hook reply (the allow or deny a pending hook call gets under section 5, recorded as the close of the permission question). Every other op the engine sends to a running worker is first stored as a pending intent; the `closeStdin` on a park stays a `park` intent (DIPO-50 note).

Delivered by dipo (M1a run 2, run_01M55EM75CBSWYH0TE2QQPAD7N, Sonnet medium): 66 turns, about $0.87, In Review on DIPO-126/one-stored-intent-helper. The worker saw 23 test failures inside its sandbox and did not check them against the base; verify outside the sandbox passed (3148 tests), so they were sandbox-only.

Maintainer side: review blocked once because the worker's notes claimed a proposed 0008 note that did not exist; fixed on top in DIPO-126/one-stored-intent-helper-review with the proposed note above, an accurate record-only list, reasons in the intents.ts header and a comment in act(). The 0008 note waits for the maintainer's approval.
<!-- SECTION:NOTES:END -->
