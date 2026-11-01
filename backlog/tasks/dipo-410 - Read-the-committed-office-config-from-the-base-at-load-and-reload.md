---
id: DIPO-410
title: Read the committed office config from the base at load and reload
status: Parked
assignee: []
created_date: '2026-11-01 08:57'
updated_date: '2026-11-01 12:29'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/office/manager.ts
  - packages/engine/src/config/load.ts
  - packages/engine/src/git/office.ts
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

Design (maintainer, 2026-11-01): every read of the committed office.yaml takes it from the base commit, `refs/remotes/<remote>/<base>`, as `readBaseOfficeFile` does: office load, `office.reloadConfig`, the poll and rescan. One read path; the checkout read of office.yaml is removed (0001). `office.local.yaml` stays in the checkout. Only when the repository has no remote base ref yet (a new repository) does load read the checkout, with a notice. How load finds the base before it has the config: it builds the office git from what it knows without the committed file, the remote and base from office.local.yaml when it sets them, else `origin` and `refs/remotes/<remote>/HEAD` (as `resolveBaseIn` does with no configured base), reads office.yaml at that base, and when that file names another `base` or remote, reads once more at that one and stops. Remove `readOfficeText` (manager.ts about 140) and the branch of `#readConfig` that reads the checkout; `loadOfficeConfig(dir)` callers outside the manager (grep them) either pass the base text or say in the PR why they keep a checkout read. Load seeds the last base text it read (`seenOnBase`), so the first poll does not reload for nothing. `dipo config migrate` keeps writing the checkout file: the migrated file reaches the base through a PR, and the daemon reads it once that merges; ADR 0017 says so. ADR 0017 also gets one sentence naming the base as the source. 0017, 0007, 0010, 0001.

```dipo
branch: "DIPO-410/office-config-from-base"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) office load and reload-config read .dipo/office.yaml from the base commit, not the checkout, and a fetch reads the same source"
park:
  reason: "ambiguous-spec"
  from: "In Progress"
  note: "Criterion 5 asks me to write the base-commit sentence into docs/decisions/0017 and to say that `dipo config migrate` writes the checkout file that reaches the base through a PR. The worker contract says I never write decision records. Should dipo apply decisionNotes[0] to section \"5. Format and files\" of 0017, or may I edit that ADR directly?"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Office load and `office.reloadConfig` read .dipo/office.yaml from the base commit (`refs/remotes/<remote>/<base>`) through the same function the poll and rescan use, shown by a test with a real git remote whose checkout is on an older commit with a different office.yaml: the loaded config and its hash are the base's
- [ ] #2 The checkout read of office.yaml is removed; office.local.yaml is still read from the checkout, shown by a test
- [ ] #3 A repository with no remote base ref loads the checkout's office.yaml with a named notice (for example `config.fromCheckout`), and switches to the base on the first fetch that creates the ref, shown by a test
- [ ] #4 An invalid office.yaml on the base still blocks new runs with config.invalid as now, and a reload after a fixed base clears it, shown by a test
- [ ] #5 ADR 0017 names the base commit as the one source of the committed office config at start, reload and fetch, and says `dipo config migrate` writes the checkout file that reaches the base through a PR
- [ ] #6 When the base office.yaml names a `base` or remote other than the one load started from, load reads the file again at that base once, shown by a test; the first poll after load does not reload when the base is unchanged
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parked 2026-11-01 12:29 UTC: ambiguous-spec
- Detail: Criterion 5 asks me to write the base-commit sentence into docs/decisions/0017 and to say that `dipo config migrate` writes the checkout file that reaches the base through a PR. The worker contract s…
- Run: run_01M6BGXNG9Y50SFRQHF58RJ5DD
- Criteria met: 5 of 6 (as the worker reported them)
- Loops: 0 of 3; CI attempts: 0 of 2
- Review rounds: 0, failed 0 of 3
- Budget used: 200,678 of 300,000 tokens; 49 of 90 turns; 8 of 45 minutes
- Last good commit: bc45e49270ebb97a39b25820593c831654300c3b
<!-- SECTION:NOTES:END -->
