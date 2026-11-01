---
id: DIPO-410
title: Read the committed office config from the base at load and reload
status: Refined
assignee: []
created_date: '2026-11-01 08:57'
updated_date: '2026-11-01 08:57'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/office/manager.ts
  - packages/engine/src/config/load.ts
  - packages/engine/test/office/
  - docs/decisions/0017-testing-strategy-and-configuration.md
priority: high
type: bug
ordinal: 388000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: one daemon always runs with the office config committed on the base, so a story's run and review use what main says, whatever commit the maintainer's checkout is on.

Gap G21, 2026-10-31: the office path is the maintainer's main checkout, detached at an old commit whose .dipo/office.yaml has no `review` block. Office load (packages/engine/src/office/manager.ts `#load` → `#readConfig`, about lines 339 and 386) and `office.reloadConfig` (`#reloadConfig`, about 787) read the checkout's working tree through `loadOfficeConfig(instance.path)` (config/load.ts about 288), while a successful poll fetch and `office.rescan` read the base commit through `readBaseOfficeFile` (manager.ts about 160, via `offices.reloadIfChanged`), and only on a change. So after a restart DIPO-400 ran with the checkout's defaults (reviewer opus at effort high) while main says effort medium and sonnet for tier:S; before it, a poll had read main's file. The box image already reads the base (box/image.ts about 494).

Design (maintainer, 2026-11-01): every read of the committed office.yaml takes it from the base commit, `refs/remotes/<remote>/<base>`, as `readBaseOfficeFile` does: office load, `office.reloadConfig`, the poll and rescan. One read path; the checkout read of office.yaml is removed (0001). `office.local.yaml` stays in the checkout. Only when the repository has no remote base ref yet (a new repository) does load read the checkout, with a notice. ADR 0017 gets one sentence naming the base as the source. 0017, 0007, 0001.

```dipo
branch: "DIPO-410/office-config-from-base"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) office load and reload-config read .dipo/office.yaml from the base commit, not the checkout, and a fetch reads the same source"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Office load and `office.reloadConfig` read .dipo/office.yaml from the base commit (`refs/remotes/<remote>/<base>`) through the same function the poll and rescan use, shown by a test with a real git remote whose checkout is on an older commit with a different office.yaml: the loaded config and its hash are the base's
- [ ] #2 The checkout read of office.yaml is removed; office.local.yaml is still read from the checkout, shown by a test
- [ ] #3 A repository with no remote base ref loads the checkout's office.yaml with a notice, and switches to the base on the first fetch that creates the ref, shown by a test
- [ ] #4 An invalid office.yaml on the base still blocks new runs with config.invalid as now, and a reload after a fixed base clears it, shown by a test
- [ ] #5 ADR 0017 names the base commit as the one source of the committed office config at start, reload and fetch
<!-- AC:END -->
