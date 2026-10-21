---
id: DIPO-269
title: Add the maintainer's login to a box's model requests outside the box
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
  - packages/engine/src/box/model-proxy.ts
  - packages/engine/src/box/token.ts
  - packages/engine/test/box/model-proxy.test.ts
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
- [ ] #1 dipo stores and reads the token in the macOS Keychain under a dipo entry; a dipo command lets the maintainer set or replace it
- [ ] #2 The model proxy listens only on the box network's host address, passes only /v1/messages and /v1/messages/count_tokens, and does not follow redirects
- [ ] #3 The box gets only a placeholder key, ANTHROPIC_BASE_URL on the model proxy and NO_PROXY for that address
- [ ] #4 A check after a run reports whether the token occurs in the box's environment or files and holds the adapter if it does
- [ ] #5 Unit tests cover the path rule and the header handling
<!-- AC:END -->
