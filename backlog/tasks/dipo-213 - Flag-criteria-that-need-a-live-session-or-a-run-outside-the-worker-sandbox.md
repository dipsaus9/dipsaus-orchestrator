---
id: DIPO-213
title: Flag criteria that need a live session or a run outside the worker sandbox
status: Refined
assignee: []
created_date: '2026-10-19 14:43'
updated_date: '2026-10-19 14:43'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/config/schema.ts
  - packages/engine/schema/office.schema.json
  - packages/engine/test/config/
  - packages/engine/test/gate/
priority: medium
type: feature
ordinal: 213000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the Ready gate's R27 default phrases also catch criteria that ask the worker for a live Claude capture, a run outside its sandbox or text in the PR, so such a story is fixed before a worker spends turns on it.

Context: review of the 2026-10-18 Ready batch (PR #218). DIPO-145 and DIPO-164 had criteria that needed a live recording (a worker has no network), DIPO-200 one that needed a macOS run outside the worker sandbox and "the PR states the cause" (a worker writes no PR text). R27 (DIPO-188) did not catch them: its default list in packages/engine/src/config/schema.ts holds task notes, implementation notes, by the maintainer and backlog task edit. Phrases match as R10 matches, so text inside a code span or a path token does not count (DIPO-170). Changing the default list is not a config version bump; the key exists since version 6.

```dipo
branch: "DIPO-213/r27-live-and-outside-phrases"
unknowns:
  - q: "Which phrases join the R27 defaults? Proposed: 'live recording', 'live capture', 'outside the sandbox', 'outside the worker sandbox', 'the PR states', 'the PR description'. 'outside the sandbox' can also describe behaviour a criterion legitimately checks (a write outside the sandbox is refused), so it may give false positives; leave it out, keep it, or use only 'run outside the sandbox'?"
    status: "open"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the gate fails a criterion that asks for each new default phrase, and passes the same phrase inside a code span"
    - kind: "automated"
      check: "(unit) the office config defaults list the new phrases and office.schema.json is regenerated"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The default story.maintainerStepPhrases in packages/engine/src/config/schema.ts holds the phrases the maintainer chose for the unknown, and packages/engine/schema/office.schema.json is regenerated
- [ ] #2 A test in packages/engine/test/gate/ fails a criterion for each new phrase with the R27 message and passes the same phrase inside a code span
<!-- AC:END -->
