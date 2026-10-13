---
id: DIPO-71
title: Store gate decisions and show them with dipo gate
status: In Progress
assignee: []
created_date: '2026-10-12 09:21'
updated_date: '2026-10-13 07:53'
labels:
  - 'tier:S'
milestone: m-0
dependencies:
  - DIPO-22
  - DIPO-27
  - DIPO-30
references:
  - packages/engine/src/gate/store/
  - packages/engine/src/db/migrations/
  - packages/engine/src/features.ts
  - packages/cli/src/
  - packages/engine/test/gate/
  - packages/contract/
documentation:
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0007-state-database.md
  - docs/decisions/0012-story-standard.md
priority: high
type: feature
ordinal: 30500
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine stores every pickup-mode gate evaluation with its rule results and the story content hash, serves the read `story.gate` with the ready-mode result without storing it, and `dipo gate <id>` prints that result.

Context: split from DIPO-30 in the M0 review (DIPO-15); DIPO-30 keeps the pure `evaluateGate`. The `ready` command is M3. In M0 the gate runs as the pickup re-check inside `work.run` (DIPO-48) and through this read-only check (M0 breakdown decision D3, DIPO-15). The structural check of the backlog PR (DIPO-35) matches a new `Ready` against a stored passing decision. The read is added through the registration seam of DIPO-22 (`register(registry)` listed in `packages/engine/src/features.ts`). References: 0007 section 4 (`gates`, `gate_decisions` with rule results and content hash); 0012 section 3 (decision stored in the local database); 0005 section 7 (reads) and section 11 (`since`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-71/store-gate-decisions-show-them-dipo-gate"
unknowns:
  - q: "Whether M0 ships the read-only `story.gate` read and `dipo gate`?"
    status: "resolved"
    answer: "maintainer decision D3 of the M0 breakdown (2026-10-11, recorded in DIPO-15): yes; the maintainer sets Ready with the Backlog CLI, `dipo gate <id>` is read-only, and `run` refuses a story that fails the gate."
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a pickup-mode evaluation stores one decision with every rule result and the content hash."
    - kind: "automated"
      check: "(engine) `story.gate` on a failing fixture story returns every failure message and stores nothing."
    - kind: "automated"
      check: "(unit) the content hash changes when a criterion changes and stays equal when only free context in the description changes."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A migration adds `gates` and `gate_decisions` with the columns of 0007 section 4; a decision stores mode, every rule result and the story content hash.
- [ ] #2 `recordGateDecision(office, story, mode)` evaluates with `evaluateGate` (DIPO-30) and stores the decision in one transaction; every pickup-mode evaluation is stored.
- [ ] #3 The story content hash is sha256 over the canonical JSON of the story fields the gate reads, so free context in the description does not change it.
- [ ] #4 `findPassingDecision(office, key, contentHash)` returns the latest passing decision for that hash, or none.
- [ ] #5 Read `story.gate { office, story }` (contract minor, registered through the DIPO-22 registry) returns the ready-mode result and stores nothing.
- [ ] #6 `dipo gate <id>` prints `ready <ID> passed` or each failure message on its own line, and exits 1 when any rule fails.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Split from DIPO-30 in the M0 review (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
