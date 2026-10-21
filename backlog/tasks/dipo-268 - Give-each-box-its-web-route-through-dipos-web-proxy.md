---
id: DIPO-268
title: Give each box its web route through dipo's web proxy
status: Refined
assignee: []
created_date: '2026-10-21 13:44'
updated_date: '2026-10-21 13:45'
labels:
  - 'tier:M'
  - cutover
  - box
milestone: m-1
dependencies:
  - DIPO-265
references:
  - packages/engine/src/box/web-proxy.ts
  - packages/engine/test/box/web-proxy.test.ts
priority: high
type: feature
ordinal: 257000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a box reaches the internet only through dipo's web proxy, which listens only on the box network's address on the Mac, sends registry traffic through Safe-Chain and opens other tunnels only to public internet addresses, as proven in the DIPO-264 probe.

Context: Decision 0021 (worker isolation, DIPO-263) and the probe results of DIPO-264 (tools/box-probe/RESULTS.md and the 0021 amendment of 2026-10-21).

```dipo
branch: "DIPO-268/box-web-proxy"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The web proxy listens only on the box network's host address and starts and stops with the boxes that use it
- [ ] #2 Tunnels to the npm and PyPI registries (host name normalised) go to dipo's Safe-Chain proxy
- [ ] #3 Other tunnels go only to public addresses: IP literals are refused, and so are names that resolve to the Mac's own addresses, its on-link prefixes, private, shared, link-local or multicast ranges, 64:ff9b::/96, 2002::/16 or the box network
- [ ] #4 Unit tests cover the address rule and the routing; the opt-in real-box test repeats the DIPO-264 lines through the proxy
<!-- AC:END -->
