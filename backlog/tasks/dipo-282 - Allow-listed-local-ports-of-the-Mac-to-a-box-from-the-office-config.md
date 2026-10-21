---
id: DIPO-282
title: Allow listed local ports of the Mac to a box from the office config
status: To Do
assignee: []
created_date: '2026-10-21 13:54'
updated_date: '2026-10-21 14:35'
labels:
  - box
  - cutover
  - needs-refinement
milestone: m-1
dependencies:
  - DIPO-281
  - DIPO-266
  - DIPO-285
references:
  - packages/engine/src/box/web-proxy.ts
  - packages/engine/src/config/schema.ts
  - packages/engine/test/box/web-proxy.test.ts
type: feature
ordinal: 271000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the office config can list local ports of the Mac that a box may reach (0021 decision 10); without an entry nothing local is allowed.
Context: Decision 0021 (worker isolation, DIPO-263) and the probe results of DIPO-264 (tools/box-probe/RESULTS.md and the 0021 amendment of 2026-10-21).

```dipo
branch: "DIPO-282/local-port-allowlist"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The office config holds a list of allowed local ports, read from the base branch
- [ ] #2 Through the web proxy, only listed local ports of the Mac are reachable from a box, shown by tests with a listed and an unlisted port; the accepted risk for Mac services that listen on all interfaces stays until DIPO-283
<!-- AC:END -->
