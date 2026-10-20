---
id: DIPO-244
title: Teach the recordings tool the two-call launch self-test
status: Done
assignee: []
created_date: '2026-10-20 18:34'
updated_date: '2026-10-20 23:26'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies:
  - DIPO-231
  - DIPO-250
references:
  - tools/recordings/scenarios.ts
  - tools/recordings/checks.ts
  - packages/engine/test/workers/self-test.test.ts
  - packages/engine/test/recordings/claude-cli/
  - tools/recordings/capture.test.ts
  - tools/recordings/capture.ts
  - packages/engine/src/index.ts
priority: medium
type: chore
ordinal: 244000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `bun run recordings:capture` captures the launch self-test as DIPO-231 runs it, with the probe call and the approval call `cd .; ls` and their approval evidence, so a recaptured safety recording passes the replay test without the synthetic two-call override.

Context: DIPO-231 (finished on 2026-10-20, review advisory) makes the self-test plan two Bash calls and judge an approval evidence (result, cliDenied, reached) from a host-protocol stand-in. tools/recordings/scenarios.ts still calls selfTestBashCalls with the single probe command and judgeSelfTest with no approval, so any new capture of a safety scenario records verdict.ok false (absent approval refuses). The replay test "(unit) live safety recordings" in packages/engine/test/workers/self-test.test.ts reads packages/engine/test/recordings/claude-cli/safety-* and, because those recordings predate the approval call, overrides calls to SELF_TEST_BASH_CALLS and passes a synthetic dipo-denied approval. That keeps their sandbox-probe evidence meaningful but proves nothing about the approval path.

Review note (2026-10-21): the host for a captured session starts in tools/recordings/capture.ts (fixtureHost, only when scenario.hookRelay is set; hostAnswer never answers a PermissionRequest), and the safety scenarios set no hookRelay, so their plan has no hooks; the stand-in that denies the approval call must run during the session, in capture.ts. scenarios.ts imports from packages/engine/src/index.ts, which does not export APPROVAL_COMMAND, approvalFacts, startHostStandIn or selfTestSocketPath yet.

```dipo
branch: "DIPO-244/recordings-two-call-self-test"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) tools/recordings/capture.test.ts: the capture of a safety scenario plans [probe, cd .; ls], starts a stand-in at the session's own socket, and writes the approval evidence into the recording's checks"
    - kind: "automated"
      check: "(unit) the replay test judges a recording that holds approval evidence with that evidence and its own call count, and keeps the override only for a recording without it"
    - kind: "manual"
      check: "(live) recapture the safety recordings with bun run recordings:capture on the pinned CLI"
      expect: "each recording holds approval evidence with reached true and dipo's reason, and its replay test passes with no override"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 tools/recordings/scenarios.ts plans the self-test's two calls (the probe and APPROVAL_COMMAND), runs the host-protocol stand-in for the captured session at the session's own socket, and writes the approval evidence (result, cliDenied, reached) and the two-call bash evidence into the recording's checks
- [x] #2 The replay test in packages/engine/test/workers/self-test.test.ts judges a recording whose checks hold approval evidence with that evidence and its recorded call count, and uses the synthetic two-call override only for a recording without approval evidence, with the reason in a comment
- [x] #3 A test in tools/recordings/capture.test.ts shows a captured safety scenario with a passing approval evidence and verdict ok, using a fake session
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M5DS0F8KEJHHKR57BHK72JGK (Haiku, 72 turns, about $0.34), verified and reviewed by dipo (its reviewer, Opus, approved round 1), with no denied call and no write outside the References. The recordings tool learns DIPO-231's two-call launch self-test: a safety scenario plans the probe and the approval call cd .; ls, capture.ts starts the engine's host-protocol stand-in at the session's own socket (selfTestSocketPath) during the session and stops it afterwards, and verify builds the approval evidence from what reached the stand-in and passes it to judgeSelfTest; absent approval still refuses. The replay test keeps its synthetic two-call override only for recordings without approval evidence, until the three safety recordings are recaptured live. The self-test pieces the tool needs are exported from the engine index. Fixed on top after review: the stand-in starts inside the try, so a stand-in that fails to start still stops the fixture host. Independent review passed (no test spawns claude; the import-boundary lint passes). Not done: the test plan's manual live recapture of the safety recordings (the maintainer's wave test), after which the no-approval branch of the replay test should be removed; no unit test drives capture() itself. Verify outside the sandbox: exit 0; DIPO_TEST_CI=1 workers and recordings tests pass (860).
<!-- SECTION:NOTES:END -->
