---
id: DIPO-133
title: Read the merge slot's required checks from the office config
status: Done
assignee: []
created_date: '2026-10-16 14:39'
updated_date: '2026-10-17 22:20'
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
- [x] #1 An office config key (for example mergeSlot.requiredChecks) lists the check names the merge slot waits for, with the default ci-ok and pr-title, in the next office config version with its migration
- [x] #2 The merge slot waits for the configured names for every PR it merges; an empty list or a duplicate name is refused by config validation with the key named
- [x] #3 The office config JSON Schema packages/engine/schema/office.schema.json (written by bun packages/engine/scripts/write-schema.ts) and the config and office tests that pin the version are updated; an office without the key behaves as today
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M55Y5WSQ48X8SY6HQ23CMPRP (Haiku low, 53 turns, about $0.10, 5 min) reported done. Office config version 3 adds mergeSlot.requiredChecks (default ci-ok and pr-title; an empty list or a duplicate name is refused with the key named); version 2 migrates as identity and gets the defaults. The merge slot waits for the configured names (#namesOf in #pick and #advance). office.schema.json regenerated. Unchanged by design: a pending check that is not listed still makes the slot wait. Verify outside the sandbox on DIPO-133/merge-slot-check-names-finish: 3178 pass, 2 skip, 0 fail; DIPO_TEST_CI=1 merge-slot, config, office and daemon tests 351 pass.

Review advisories applied on the finish branch: a version hint table in config/load.ts (mergeSlot -> 3, worker.plugins -> 2; office.local.yaml never gets it, since it does not accept mergeSlot), an office-v3.yaml fixture with a migration test from the v2 fixture, and the checks.ts header names mergeSlot.requiredChecks. Verify: 3181 pass, 2 skip, 0 fail. Left for DIPO-139: the comment at the MergeSlot construction in packages/daemon/src/foreground.ts still names ci-ok and pr-title.
<!-- SECTION:NOTES:END -->
