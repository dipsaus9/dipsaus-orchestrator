---
id: DIPO-269
title: Add the maintainer's login to a box's model requests outside the box
status: Done
assignee: []
created_date: '2026-10-21 13:44'
updated_date: '2026-10-21 15:52'
labels:
  - 'tier:M'
  - cutover
  - box
milestone: m-1
dependencies:
  - DIPO-265
references:
  - packages/engine/src/box/model-proxy.ts
  - packages/engine/src/box/token.ts
  - packages/engine/test/box/model-proxy.test.ts
  - packages/engine/src/box/token-check.ts
  - packages/engine/src/box/index.ts
  - packages/engine/src/platform/box-host.ts
  - packages/engine/src/index.ts
  - packages/engine/test/box/token.test.ts
  - packages/engine/test/box/token-check.test.ts
  - packages/daemon/src/login.ts
  - packages/daemon/src/login.test.ts
  - packages/daemon/src/index.ts
  - packages/cli/src/index.ts
  - packages/cli/src/index.test.ts
  - packages/engine/src/box/apple-args.ts
  - packages/engine/src/box/apple-container.ts
  - packages/engine/src/box/port.ts
  - packages/engine/test/box/args.test.ts
  - packages/engine/test/box/apple-container.test.ts
priority: high
type: feature
ordinal: 258000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a box's Claude Code reaches the model only through dipo's model proxy, which keeps the maintainer's subscription token in the macOS Keychain, passes only model requests and adds the login on the way out, so the token never enters a box.

Context: Decision 0021 (worker isolation, DIPO-263) and the probe results of DIPO-264 (tools/box-probe/RESULTS.md and the 0021 amendment of 2026-10-21).

```dipo
branch: "DIPO-269/box-model-proxy"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 dipo stores and reads the token in the macOS Keychain under a dipo entry; a dipo command lets the maintainer set or replace it
- [x] #2 The model proxy listens only on the box network's host address, passes only /v1/messages and /v1/messages/count_tokens, and does not follow redirects
- [x] #3 The box gets only a placeholder key, ANTHROPIC_BASE_URL on the model proxy and NO_PROXY for that address
- [x] #4 A check after a run reports whether the token occurs in the box's environment or files and holds the adapter if it does
- [x] #5 Unit tests cover the path rule and the header handling
<!-- AC:END -->
