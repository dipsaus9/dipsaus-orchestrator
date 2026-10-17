---
id: DIPO-133
title: Read the merge slot's required checks from the office config
status: Ready
assignee: []
created_date: '2026-10-16 14:39'
updated_date: '2026-10-17 21:14'
labels:
  - 'tier:S'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-115
references:
  - packages/engine/src/merge-slot/
  - packages/engine/src/config/
  - packages/engine/schema/
  - packages/engine/scripts/write-schema.ts
  - packages/engine/test/merge-slot/
  - packages/engine/test/config/
  - packages/engine/test/office/
priority: high
type: feature
ordinal: 123000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: each office says which required checks the merge slot waits for before it merges a PR, so story PRs (M1a) and offices whose CI uses other check names merge through the slot.

Context: the merge slot waits for the hard-coded REQUIRED_CHECKS ci-ok and pr-title (packages/engine/src/merge-slot/checks.ts, 0016 rule 2). Those are this repository's names; another office's branch protection can require others, and its backlog PRs, and from M1a its story PRs, would then never merge or would merge early. Every office config key is added with a version bump and an in-memory migration (packages/engine/src/config/schema.ts, 0017 amendment of 2026-10-12); DIPO-116 and the M1a review block also add keys, so this takes the next free version and the later ones build on it. Found by the 2026-10-16 milestone review (DIPO-73 follow-up).

```dipo
branch: "DIPO-133/merge-slot-check-names"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the config migration adds the default check names, and validation refuses an empty list and a duplicate name"
    - kind: "automated"
      check: "(unit) the merge slot waits for the configured check names and merges only when each of them passed"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An office config key (for example mergeSlot.requiredChecks) lists the check names the merge slot waits for, with the default ci-ok and pr-title, in the next office config version with its migration
- [ ] #2 The merge slot waits for the configured names for every PR it merges; an empty list or a duplicate name is refused by config validation with the key named
- [ ] #3 The office config JSON Schema packages/engine/schema/office.schema.json (written by bun packages/engine/scripts/write-schema.ts) and the config and office tests that pin the version are updated; an office without the key behaves as today
<!-- AC:END -->
