---
id: DIPO-383
title: Start the box web route reliably when Safe-Chain is slow to come up
status: Done
assignee: []
created_date: '2026-10-30 08:53'
updated_date: '2026-10-30 10:55'
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
- [x] #1 The PR names the cause: which step after the start script's ready line does not pass the check's request on time (the forwarders, the web proxy's target path to the box, or Safe-Chain's upstream fetch), shown by the Safe-Chain box's output and the upstream listener's events from a real box
- [x] #2 The fix acts on that step: the readiness the route waits for covers the failing step (a signal from it, not a longer fixed sleep), within SAFE_CHAIN_READY_TIMEOUT_MS
- [x] #3 When the check still fails, the route's error and the info log carry the Safe-Chain box's last output lines and the upstream listener's events, capped at 40 lines, so the cause is readable without debug logs
- [x] #4 What the old check caught, each with a test: the allowed download not returning 200 fails the route; safe-chain-test not refused with 403 fails it; the web proxy's own 403 is not taken for Safe-Chain's refusal; a refused CONNECT fails it
- [x] #5 Bypass forms are tested: a Safe-Chain that printed its ready line but never forwards fails the route; a Safe-Chain process or box that ended during any added wait fails it, never passes it; no tunnel goes to the Safe-Chain box (target set) before the check has passed
- [x] #6 A fail-closed test against the real path (DIPO_TEST_BOX=1) with a Safe-Chain that never forwards shows the route does not start and no install reaches a registry
- [x] #7 A real-box test (DIPO_TEST_BOX=1) removes the Safe-Chain image to force a rebuild, then starts the route ten times in a row, and all ten pass
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Most likely cause, from fault injection on real boxes (no natural reproduction in 25 starts): Safe-Chain loads its malware list lazily on the first proxied request, and when the Mac's connect to malware-list.aikido.dev hung, the upstream listener waited 30 s per address and logged nothing, so the check timed out three times. The upstream connect now tries the resolved addresses staggered 250 ms apart with a 5 s deadline each and logs every failed connect; the start script makes each Safe-Chain process load its list before the ready line, within the ready timeout, else the route fails closed. A failed start logs, at warn and in the route error, the Safe-Chain box output and the last upstream events, the whole reason capped at 40 lines. What the old check refused is pinned and still refused; a ready-but-not-forwarding Safe-Chain, a box ending during the load and Safe-Chain ending during the check each fail the route; a real-box test starts the route ten times after a forced image rebuild, all pass.
<!-- SECTION:FINAL_SUMMARY:END -->
