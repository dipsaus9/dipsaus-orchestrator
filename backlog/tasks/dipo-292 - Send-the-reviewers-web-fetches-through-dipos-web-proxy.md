---
id: DIPO-292
title: Send the reviewer's web fetches through dipo's web proxy
status: Refined
assignee: []
created_date: '2026-10-21 23:03'
updated_date: '2026-10-22 05:33'
labels:
  - 'tier:M'
  - box
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/workers/claude-cli/plan.ts
  - packages/engine/src/run/review-launch.ts
  - packages/engine/src/box/web-proxy.ts
  - packages/engine/test/workers/review-tools.test.ts
type: bug
ordinal: 281000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a reviewer's (and any Mac worker's) WebFetch connects only through dipo's web proxy, so the address rule runs at connect time on the address actually used, closing DNS rebinding and same-host redirects to the Mac or the local network.

Context: DIPO-276 (PR #325) checks the address in the web guard before Claude Code fetches by name itself; its review found the name check alone does not cover every connect-time address. The reviewer runs on the Mac without a box, so it gets its own listener of the same proxy and address rules, started for the length of the review session (the box web proxy listens only on the box network, which exists only while a box runs).

```dipo
branch: "DIPO-292/reviewer-web-proxy"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The reviewer's session gets HTTPS_PROXY and HTTP_PROXY on dipo's web proxy and NO_PROXY only for the model API, so every fetch tunnels through the proxy
- [ ] #2 A fetch to a name that resolves, or redirects, to a non-public address is refused by the proxy at connect time, shown by tests
- [ ] #3 The web guard's name check stays as a first layer
<!-- AC:END -->
