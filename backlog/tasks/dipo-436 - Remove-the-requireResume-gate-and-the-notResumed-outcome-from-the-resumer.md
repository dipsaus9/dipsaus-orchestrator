---
id: DIPO-436
title: >-
  Remove the resumer's dead requireResume path and test the order around a
  worker's exit
status: Refined
assignee: []
created_date: '2026-10-31 08:13'
updated_date: '2026-11-03 07:08'
labels:
  - 'tier:S'
milestone: m-2
dependencies: []
references:
  - packages/engine/src/run/resume.ts
  - packages/engine/src/run/outcome-sessions.ts
  - packages/engine/src/create/compose.ts
  - packages/engine/src/run/control.ts
  - packages/engine/test/run/reattach.test.ts
  - packages/engine/test/create/compose.test.ts
priority: low
type: chore
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the resumer has no path nothing can reach, and the order dipo keeps around an ordinary worker exit (what Safe-Chain refused is kept first, the run's temp folder and box are swept after) has a test again.

Filed from DRAFT-6 and DRAFT-9 (both proposed by the worker of DIPO-384). DIPO-384 removed the only caller that set `requireResume` (a host lost while the daemon was down; such a host now parks). Left behind: the `requireResume` field and the `{ kind: "notResumed" }` outcome in packages/engine/src/run/resume.ts (request type about lines 244-247, outcome type about line 263, the branch about lines 437-438); the field and its `notResumed` case in packages/engine/src/run/outcome-sessions.ts (about lines 46-47, 78 and 108-114); and the test "keeps the held messages when the session does not start" in packages/engine/test/run/reattach.test.ts (about lines 2058-2066), the only thing that still reaches it. Nothing else reads `NextSessionOutcome`. DIPO-384 also removed the tests that showed DIPO-376's order (`beforeExit`: what Safe-Chain refused is kept before the exit is decided; `afterExit`: the temp folder sweep and the box check), because they went through the lost-host path (`control.track`, `control.onHostLost`, `control.idle()`). `exitPortOf` and `beforeRunExits` in packages/engine/src/create/compose.ts (about lines 598-630) have no test of that order now; the port reaches run control through `partners.exitPort` (about line 650).

Design: the field, the outcome kind and both branches go. The `notResumed` reason on the `started` outcome (why a handoff did not resume, shown in its notice; resume.ts about lines 260, 639 and 661) stays, and so does starts-paused.ts's `parkNotResumed` notice, which is a different thing. The held-messages test keeps its check (held messages stay pending when no session starts) but gets there through a start that fails: `realResumer`'s `prepare` override returning `ok: false` gives `startFailed` before any host starts, and held messages are delivered only when a session is recorded. A new test in packages/engine/test/create/compose.test.ts drives an ordinary developer exit through the composed runs, as the removed tests did but ending with `control.onEnded(run, agent, end)` (packages/engine/src/run/control.ts about line 746) instead of a lost host, and shows `beforeExit` is awaited before the exit is decided and `afterExit` runs after it; `exitPortOf` stays unexported. A lost host's leftovers still wait for the daemon-start sweep; that is not changed here. 0001.

```dipo
branch: "DIPO-436/resume-dead-path-exit-order"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) requireResume and the notResumed outcome are gone from the resumer, the held-messages test reaches a session that fails to start another way, and a test through control.onEnded shows beforeExit is awaited before an ordinary exit is decided and afterExit runs after it"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 resume.ts and outcome-sessions.ts have no `requireResume` field, no `notResumed` outcome kind and no branch for either, shown by the diff; the handoff's `notResumed` reason and starts-paused.ts's notice stay
- [ ] #2 The held-messages test shows held messages stay pending when the new session fails to start (`startFailed`), without `requireResume`
- [ ] #3 A test through the composed runs and `control.onEnded` shows that for an ordinary developer exit `beforeExit` is awaited before the exit is decided and `afterExit` runs after it
<!-- AC:END -->
