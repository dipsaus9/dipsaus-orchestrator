---
id: DIPO-169
title: Refine worker research access
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-21 09:21'
labels:
  - 'tier:M'
milestone: m-1
dependencies:
  - DIPO-164
references:
  - packages/engine/src/workers/
  - packages/engine/src/config/
  - docs/decisions/
priority: medium
type: feature
ordinal: 158000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a decision and its code set which domains a worker may fetch, a research budget or call cap per story, and which web calls are stored as facts, replacing the open web access of DIPO-164.

Context: the follow-up ADR 0020 section 11b names (risk accepted for now: no domain allowlist, no separate research budget). Not in slice:m1a; the maintainer sets its slice. The decision needs the maintainer's approval before it lands in docs/decisions/.

```dipo
branch: "DIPO-169/refine-worker-research-access"
unknowns:
  - q: "Which domains may a worker fetch: an allowlist, a denylist, or open with logging?"
    status: "open"
  - q: "Is research limited by a budget in tokens, a call cap per story, or both, and at what size?"
    status: "open"
  - q: "Which web calls are stored as facts, with which fields and which retention tier?"
    status: "open"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a fetch outside the decided domains and a call past the cap are refused with the reason"
    - kind: "automated"
      check: "(unit) the config migration adds the decided keys with their defaults"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A decision in docs/decisions/, a new ADR or a dated amendment of 0020 approved by the maintainer, states the allowed fetch domains or the rule for them, a research budget or call cap per story, and which web calls are stored as facts
- [ ] #2 The Claude adapter enforces the decided domains and cap for WebFetch and WebSearch and refuses a call outside them with a reason shown in the worker output
- [ ] #3 The office config carries the decided keys with defaults in the next config version with its migration, and the web calls the decision names are stored as facts
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Replaced by decision 0021 (worker isolation, DIPO-263, 2026-10-21): the maintainer chose full internet access for workers, with registries only through Safe-Chain (0021 section 3).
<!-- SECTION:NOTES:END -->
