---
id: DIPO-211
title: Retry the Safe-Chain proxy check before holding new runs
status: Done
assignee: []
created_date: '2026-10-19 14:43'
updated_date: '2026-10-19 21:21'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/platform/safe-chain-proxy.ts
  - packages/engine/test/sandbox/safe-chain-proxy.test.ts
priority: high
type: bug
ordinal: 211000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: one slow or dropped download in the Safe-Chain proxy check no longer holds new claude-cli runs in every office; the check tries the allowed download again before it reports a failure.

Context: M1a run of DIPO-145 on 2026-10-19. Two launches were refused with "the Safe-Chain proxy check failed: downloading is-number@7.0.0 through the proxy did not work (... timed out)", which holds new runs on claude-cli in every office until someone names a story again. A direct download of the same URL took 0.7 s, and the third launch a few minutes later passed. The check in packages/engine/src/platform/safe-chain-proxy.ts makes each of its three requests once (attempt, PROXY_CHECK_TIMEOUT_MS = 30 s) and proxyCheckProblem reports the first failure; nothing tries again. The blocked and refused requests prove the proxy blocks; only a failed allowed download is a candidate for a transient network problem.

```dipo
branch: "DIPO-211/retry-safe-chain-proxy-check"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) an allowed download that times out once and then succeeds passes the proxy check; one that fails on every attempt fails it with the attempt count in the problem text"
    - kind: "automated"
      check: "(unit) a blocked or refused request that the proxy lets through still fails the check at once, with no retry"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The allowed download of the proxy check is tried up to 3 times, 2 s apart on the injected clock, before it counts as failed, and a test with a fake download that fails once then succeeds shows the check passing and the 2 s wait on a ManualClock
- [x] #2 When every attempt fails, the problem text says how many attempts were made and keeps the cause of the last one
- [x] #3 The blocked and refused requests are not retried: a proxy that lets a blocked or refused download through fails the check on the first attempt, as today
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M5AZXYEJK6DC7HHD7FP8JZ1X (Haiku, 19 turns, about $0.02, 1 min) reported done, In Review, with no denied call and no write outside the References. runProxyCheck now tries the allowed download up to 3 times, 2 s apart on the injected clock; the blocked and refused downloads are tried once. The refusal text says how many attempts the allowed download got and keeps the last cause. Fixed on top after review: the retry tests use the story's 2 s and 30 s as literals, each failed attempt has its own cause so the last one is shown to be kept, and a new test covers an allowed download that hangs past the 30 s timeout and then passes on the retry. Verify outside the sandbox: 3700 tests, 2 skip, 0 fail; DIPO_TEST_CI=1 sandbox tests 105 pass. Review passed.
<!-- SECTION:NOTES:END -->
