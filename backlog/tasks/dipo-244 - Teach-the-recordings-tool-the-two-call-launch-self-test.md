---
id: DIPO-244
title: Teach the recordings tool the two-call launch self-test
status: Refined
assignee: []
created_date: '2026-10-20 18:34'
updated_date: '2026-10-20 18:47'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies:
  - DIPO-231
references:
  - tools/recordings/scenarios.ts
  - tools/recordings/checks.ts
  - packages/engine/test/workers/self-test.test.ts
  - packages/engine/test/recordings/claude-cli/
  - tools/recordings/capture.test.ts
priority: medium
type: chore
ordinal: 244000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `bun run recordings:capture` captures the launch self-test as DIPO-231 runs it, with the probe call and the approval call `cd .; ls` and their approval evidence, so a recaptured safety recording passes the replay test without the synthetic two-call override.

Context: DIPO-231 (finished on 2026-10-20, review advisory) makes the self-test plan two Bash calls and judge an approval evidence (result, cliDenied, reached) from a host-protocol stand-in. tools/recordings/scenarios.ts still calls selfTestBashCalls with the single probe command and judgeSelfTest with no approval, so any new capture of a safety scenario records verdict.ok false (absent approval refuses). The replay test "(unit) live safety recordings" in packages/engine/test/workers/self-test.test.ts reads packages/engine/test/recordings/claude-cli/safety-* and, because those recordings predate the approval call, overrides calls to SELF_TEST_BASH_CALLS and passes a synthetic dipo-denied approval. That keeps their sandbox-probe evidence meaningful but proves nothing about the approval path.

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
- [ ] #1 tools/recordings/scenarios.ts plans the self-test's two calls (the probe and APPROVAL_COMMAND), runs the host-protocol stand-in for the captured session at the session's own socket, and writes the approval evidence (result, cliDenied, reached) and the two-call bash evidence into the recording's checks
- [ ] #2 The replay test in packages/engine/test/workers/self-test.test.ts judges a recording whose checks hold approval evidence with that evidence and its recorded call count, and uses the synthetic two-call override only for a recording without approval evidence, with the reason in a comment
- [ ] #3 A test in tools/recordings/capture.test.ts shows a captured safety scenario with a passing approval evidence and verdict ok, using a fake session
<!-- AC:END -->
