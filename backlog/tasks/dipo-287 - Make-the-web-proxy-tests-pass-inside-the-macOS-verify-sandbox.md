---
id: DIPO-287
title: Make the web proxy tests pass inside the macOS verify sandbox
status: In Review
assignee: []
created_date: '2026-10-21 16:05'
updated_date: '2026-10-21 17:50'
labels:
  - 'tier:S'
  - cutover
  - box
milestone: m-1
dependencies: []
references:
  - packages/engine/test/box/web-proxy.test.ts
  - packages/engine/src/box/web-proxy.ts
  - packages/engine/test/box/model-proxy.test.ts
type: bug
ordinal: 276000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: bun run verify passes inside dipo's verify sandbox on macOS again; the web proxy tests of DIPO-268 no longer fail there because they cannot open a listening socket.

Context: found while merging DIPO-270 on 2026-10-21. CI's Linux run passes these tests, but the self-verify test and dipo's own verify of a story on the maintainer's Mac run under the verify policy, where listening on a loopback socket is refused.

```dipo
branch: "DIPO-287/proxy-tests-in-sandbox"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The self-verify test (DIPO_TEST_CI=1) passes on macOS
- [x] #2 The web proxy tests still exercise real sockets where the environment allows it, or use an in-memory transport, without widening the verify policy beyond what it allows today; the report names which
<!-- AC:END -->
