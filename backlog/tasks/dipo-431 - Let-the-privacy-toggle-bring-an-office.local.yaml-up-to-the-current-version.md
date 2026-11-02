---
id: DIPO-431
title: Let the privacy toggle bring an office.local.yaml up to the current version
status: In Progress
assignee: []
created_date: '2026-11-02 13:23'
updated_date: '2026-11-02 14:03'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/config/local-write.ts
  - packages/engine/src/config/migrate-file.ts
  - packages/engine/src/office/manager.ts
  - packages/engine/src/config/
  - packages/engine/test/office/
  - packages/engine/test/config/
  - docs/decisions/0017-testing-strategy-and-configuration.md
priority: low
type: task
ordinal: 409000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: changing a privacy setting in the TUI works on an office whose office.local.yaml is at an older version, without first running `dipo config migrate`.

Found by the review of DIPO-428 (PR #565) on 2026-11-02. DIPO-428 moved the office config to version 15. `office.setPrivacy` (packages/engine/src/office/manager.ts `#setPrivacy`, about line 850, through `updateLocalPrivacy` in packages/engine/src/config/local-write.ts, where the refusal sits) refuses an office.local.yaml below the current version, because 0017 says only `dipo config migrate` rewrites a configuration file. Every office that ever used the toggle has a version 14 office.local.yaml, which setPrivacy itself wrote, so the toggle now fails once per office with a message naming `dipo config migrate`.

Design (approved by the maintainer on 2026-11-02): setPrivacy migrates the office.local.yaml it rewrites to the current version with the same pure migration `dipo config migrate` uses, then writes it as it does today; it already drops comments and says so in the file's header. Only office.local.yaml, the file setPrivacy owns, is migrated this way; office.yaml stays migrate-only. ADR 0017's "Rewriting a file" bullet says setPrivacy rewrites office.local.yaml at the current version, and its sample's `version: 14` becomes 15. One migration path (0001). 0007, 0017.

```dipo
branch: "DIPO-431/privacy-migrates-local"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) office.setPrivacy on an older office.local.yaml writes it at the current office config version with every key kept, and ADR 0017 says so"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 setPrivacy on a version 14 office.local.yaml writes it at the current version with the new privacy value and every other key kept, shown by a test on a fixture file
- [ ] #2 setPrivacy still refuses an office.local.yaml that does not validate, and never rewrites office.yaml, shown by tests
- [ ] #3 ADR 0017 says setPrivacy rewrites office.local.yaml at the current version, and its sample shows version 15
<!-- AC:END -->
