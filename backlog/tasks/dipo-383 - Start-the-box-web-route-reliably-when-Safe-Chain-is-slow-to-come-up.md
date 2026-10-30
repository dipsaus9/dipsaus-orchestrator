---
id: DIPO-383
title: Start the box web route reliably when Safe-Chain is slow to come up
status: Refined
assignee: []
created_date: '2026-10-30 08:53'
updated_date: '2026-10-30 08:55'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/box/safe-chain-box.ts
  - packages/engine/src/box/safe-chain.ts
  - packages/engine/test/box/
  - tools/box-probe/web-proxy.ts
priority: high
type: bug
ordinal: 363000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a box web route starts every time Safe-Chain is healthy, and when the Safe-Chain check fails, the reason is in the log.

Seen twice. On 2026-10-29 the escape probe's first attempt (tools/box-probe, right after the Safe-Chain image was built from the pinned Debian base) and on 2026-10-30 `dipo run DIPO-375 --box` both failed with "the Safe-Chain check failed: downloading is-number@7.0.0 through Safe-Chain did not work after 3 attempts (... timed out)" (box.routeFailed). Each retry worked a minute later. `startSafeChainBox` already waits for the start script's ready line (both Safe-Chain processes and their forwarders up) and reads the CA bundle, within SAFE_CHAIN_READY_TIMEOUT_MS; the check then makes 3 attempts of 30 s with 2 s between (box/safe-chain-box.ts). In the probe's route log the upstream listener saw no connection from Safe-Chain during the failed check, not to the registry and not to the malware lists, so the request did not get through somewhere after the ready line: the forwarders, the web proxy's target path to the box, or Safe-Chain's own upstream fetch. The cause is not known yet. The info log says nothing; dipo's message points at debug logs.

The Safe-Chain check is the proof of a barrier (every install goes through Safe-Chain, 0008), so a change to when or how it runs follows CLAUDE.md's R30 rules. 0008, 0001.

```dipo
branch: "DIPO-383/safe-chain-check-start"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a failed check logs the Safe-Chain box output and the upstream events; each old refusal still fails the route"
    - kind: "automated"
      check: "(box) DIPO_TEST_BOX=1: ten route starts in a row after a forced Safe-Chain image rebuild all pass, and a Safe-Chain that never forwards fails the route"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The PR names the cause: which step after the start script's ready line does not pass the check's request on time (the forwarders, the web proxy's target path to the box, or Safe-Chain's upstream fetch), shown by the Safe-Chain box's output and the upstream listener's events from a real box
- [ ] #2 The fix acts on that step: the readiness the route waits for covers the failing step (a signal from it, not a longer fixed sleep), within SAFE_CHAIN_READY_TIMEOUT_MS
- [ ] #3 When the check still fails, the route's error and the info log carry the Safe-Chain box's last output lines and the upstream listener's events, capped at 40 lines, so the cause is readable without debug logs
- [ ] #4 What the old check caught, each with a test: the allowed download not returning 200 fails the route; safe-chain-test not refused with 403 fails it; the web proxy's own 403 is not taken for Safe-Chain's refusal; a refused CONNECT fails it
- [ ] #5 Bypass forms are tested: a Safe-Chain that printed its ready line but never forwards fails the route; a Safe-Chain process or box that ended during any added wait fails it, never passes it; no tunnel goes to the Safe-Chain box (target set) before the check has passed
- [ ] #6 A fail-closed test against the real path (DIPO_TEST_BOX=1) with a Safe-Chain that never forwards shows the route does not start and no install reaches a registry
- [ ] #7 A real-box test (DIPO_TEST_BOX=1) removes the Safe-Chain image to force a rebuild, then starts the route ten times in a row, and all ten pass
<!-- AC:END -->
