---
id: DIPO-383
title: Start the box web route reliably when Safe-Chain is slow to come up
status: Refined
assignee: []
created_date: '2026-10-30 08:53'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/box/safe-chain-box.ts
  - packages/engine/src/box/
  - packages/engine/test/box/
  - tools/box-probe/web-proxy.ts
priority: high
type: bug
ordinal: 363000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a box web route starts every time Safe-Chain is healthy, and when the Safe-Chain check fails, the reason is in the log.

Seen twice. On 2026-10-29 the escape probe's first attempt (tools/box-probe, right after the Safe-Chain image was built from the pinned Debian base) and on 2026-10-30 `dipo run DIPO-375 --box` both failed with "the Safe-Chain check failed: downloading is-number@7.0.0 through Safe-Chain did not work after 3 attempts (... timed out)" (box.routeFailed). Each retry worked a minute later. In the probe's route log the upstream listener saw no connection from Safe-Chain at all during the check: not to the registry and not to the malware lists, so Safe-Chain in its box was not yet forwarding (or not running) when the check began. The check makes 3 attempts of 30 s with 2 s between (SAFE_CHAIN_CHECK_ATTEMPTS, SAFE_CHAIN_CHECK_TIMEOUT_MS, SAFE_CHAIN_CHECK_RETRY_DELAY_MS in box/safe-chain-box.ts). The info log says nothing; dipo's message points at debug logs. 0008, 0001.

```dipo
branch: "DIPO-383/safe-chain-check-start"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the route waits for Safe-Chain to be ready before the check, and a failed check logs the Safe-Chain box output and the upstream events"
    - kind: "automated"
      check: "(box) DIPO_TEST_BOX=1: ten route starts in a row, the first right after the Safe-Chain image is built, all pass"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The cause is found and named in the PR: what Safe-Chain in its box is doing when the check times out, read from the Safe-Chain box's own output and the upstream listener's events on a real box
- [ ] #2 The route waits until Safe-Chain is ready to forward (a readiness signal from Safe-Chain or its box, not a longer fixed sleep) before the Safe-Chain check, within SAFE_CHAIN_READY_TIMEOUT_MS
- [ ] #3 When the check still fails, the route's error and the info log carry the Safe-Chain box's last output lines and the upstream listener's events, so the cause is readable without debug logs
- [ ] #4 The check stays fail-closed: a Safe-Chain that does not refuse safe-chain-test, or never forwards, still fails the route, shown by the existing tests and one new test against the real path
- [ ] #5 A real-box test (DIPO_TEST_BOX=1) starts the route ten times in a row, the first right after the Safe-Chain image is built, and all ten pass
<!-- AC:END -->
