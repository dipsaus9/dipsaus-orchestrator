---
id: DIPO-281
title: Send registry aliases and their CDN names through Safe-Chain in the web proxy
status: To Do
assignee: []
created_date: '2026-10-21 13:54'
updated_date: '2026-10-21 13:54'
labels:
  - box
  - cutover
  - needs-refinement
milestone: m-1
dependencies:
  - DIPO-268
references:
  - packages/engine/src/box/web-proxy.ts
  - packages/engine/test/box/web-proxy.test.ts
type: feature
ordinal: 270000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a box cannot reach a package registry without Safe-Chain by using a registry alias or another name on the registry's CDN, and the web proxy's address rule also covers the gaps the 0021 amendment lists.
Context: Decision 0021 (worker isolation, DIPO-263) and the probe results of DIPO-264 (tools/box-probe/RESULTS.md and the 0021 amendment of 2026-10-21).

```dipo
branch: "DIPO-281/registry-aliases"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Tunnels to known registry aliases and the registries' CDN names go to Safe-Chain or are refused, never direct
- [ ] #2 The address rule covers the IPv6 forms that embed a private IPv4 address
- [ ] #3 Tests cover each alias and address form
<!-- AC:END -->
