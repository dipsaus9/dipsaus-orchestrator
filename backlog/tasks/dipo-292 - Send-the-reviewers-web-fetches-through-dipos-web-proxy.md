---
id: DIPO-292
title: Send the reviewer's web fetches through dipo's web proxy
status: Done
assignee: []
created_date: '2026-10-21 23:03'
updated_date: '2026-10-22 17:37'
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
  - packages/engine/src/workers/types.ts
  - packages/engine/src/hooks/web-guard.ts
  - packages/engine/test/box/web-proxy.test.ts
  - packages/engine/test/run/review-read-only.test.ts
  - packages/engine/test/workers/launch-fixtures.ts
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
- [x] #1 The reviewer's session gets HTTPS_PROXY and HTTP_PROXY on dipo's web proxy and NO_PROXY only for the model API, so every fetch tunnels through the proxy
- [x] #2 A fetch to a name that resolves, or redirects, to a non-public address is refused by the proxy at connect time, shown by tests
- [x] #3 The web guard's name check stays as a first layer
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-22: built outside dipo (box-core fix, maintainer choice of the mix), merged as #343 after review; the review advisory on the box network address is fixed. Production SYSTEM_FETCH_ADDRESSES.boxHostAddress returns null today, so the web guard and the reviewer's listener refuse the box network through the on-link prefix of the Mac's interface; giving both a live box host address source through composeRuns is a possible follow-up. Only a live review can show Claude Code honours HTTPS_PROXY and NO_PROXY for WebFetch.
<!-- SECTION:NOTES:END -->
