---
id: DIPO-281
title: >-
  Harden the box network: registry aliases, listed Mac ports, no route to the
  Mac or the LAN
status: To Do
assignee: []
created_date: '2026-10-21 13:54'
updated_date: '2026-10-23 10:34'
labels:
  - box
  - cutover
  - needs-refinement
milestone: m-1
dependencies:
  - DIPO-268
  - DIPO-287
  - DIPO-292
  - DIPO-266
  - DIPO-285
  - DIPO-271
  - DIPO-275
  - DIPO-277
  - DIPO-240
  - DIPO-290
  - DIPO-294
  - DIPO-295
  - DIPO-296
  - DIPO-298
  - DIPO-152
references:
  - docs/decisions/0021-worker-isolation.md
  - packages/engine/src/box/
  - packages/engine/src/box/image.ts
  - packages/engine/src/box/web-proxy.ts
  - packages/engine/src/config/schema.ts
  - packages/engine/test/box/web-proxy.test.ts
type: feature
ordinal: 270000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a box reaches a package registry only through Safe-Chain, also by a registry alias or a CDN name, and the web proxy refuses the IPv6 forms that embed a private IPv4 address; the office config lists the Mac's local ports a box may reach and no other service on the Mac or its local-network address is reachable; and the box image is built with no route to the Mac, the local network or a registry except through dipo's proxies.

Context: Decision 0021 (worker isolation, DIPO-263) and the probe results of DIPO-264 (tools/box-probe/RESULTS.md and the 0021 amendment of 2026-10-21).

From DIPO-282 and DIPO-283: the same context as above.

From DIPO-286: `container build` has no network option, so today's build runs on Apple container's default network. Options to weigh in refinement: build inside a box on the host-only network and turn it into an image, or install without lifecycle scripts and run only trusted steps.

```dipo
branch: "DIPO-281/box-network-hardening"
unknowns:
  - q: "Build inside a box on the host-only network and turn it into an image, or install without lifecycle scripts and run only trusted steps?"
    status: "resolved"
    answer: "A (maintainer, 2026-10-23): build inside a box on the host-only network, with the same registry and web routes as a worker box, and turn it into the image with container commit; container build is no longer used for the office image."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Tunnels to known registry aliases and the registries' CDN names go to Safe-Chain or are refused, never direct
- [ ] #2 The address rule covers the IPv6 forms that embed a private IPv4 address
- [ ] #3 Tests cover each alias and address form
- [ ] #4 (from DIPO-282) The office config holds a list of allowed local ports, read from the base branch
- [ ] #5 (from DIPO-282) Through the web proxy, only listed local ports of the Mac are reachable from a box, shown by tests with a listed and an unlisted port; the accepted risk for Mac services that listen on all interfaces stays until DIPO-283
- [ ] #6 (from DIPO-283) The worker inside the box cannot undo the fix
- [ ] #7 (from DIPO-283) docs/decisions/0021-worker-isolation.md gets a dated amendment that closes the accepted risk
- [ ] #8 (from DIPO-283) Line 2 of the DIPO-264 probe, and the direct line to the Mac's own local-network address in the real-box web-proxy test, fail for Mac services that listen on all interfaces or on that address, except the ports the office config allows (DIPO-282)
- [ ] #9 (from DIPO-286) During an image build, no install step can reach the Mac, the local network or a registry except through dipo's proxies, shown by a real-box build test
- [ ] #10 (from DIPO-286) docs/decisions/0021-worker-isolation.md gets a dated amendment that closes the build-time risk
- [ ] #11 The web guard and the reviewer's web proxy get a live box host address source from the daemon instead of the system default that always returns none (DIPO-292 review)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
To settle in refinement: the other gaps the 0021 amendment lists (private hosts on public ranges, such as a VPN, global IPv6 or the router's own public IPv4, and installs from registries Safe-Chain does not know).

Carried from DIPO-283: To settle in refinement: how the fix holds while the worker runs with all permissions inside the box (DIPO-271), and whether it sits outside the box as 0021 section 3 asks; the amendment calls an in-box rule a second layer.

2026-10-22: combined from DIPO-282, DIPO-283, DIPO-286 (maintainer, M1 speed-up)

2026-10-22: dropped the dependency on DIPO-149 (which now holds DIPO-291) to break a dependency cycle left by the M1 combine; that story now comes after this one.
<!-- SECTION:NOTES:END -->
