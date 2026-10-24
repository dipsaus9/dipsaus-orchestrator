---
id: DIPO-338
title: >-
  Let the maintainer allow runs past a plan warning, and keep hold waits out of
  the time cap
status: Refined
assignee: []
created_date: '2026-10-24 14:57'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/run/plan-limit.ts
  - packages/engine/src/run/plan-allowance.ts
  - packages/engine/src/run/pre-start-caps.ts
  - packages/engine/src/run/places.ts
  - packages/engine/src/run/resumption.ts
  - packages/engine/src/db/migrations/
  - packages/engine/src/views/desk.ts
  - packages/contract/src/office.ts
  - packages/cli/src/limits-command.ts
  - packages/daemon/src/foreground.ts
priority: high
type: feature
ordinal: 319000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the maintainer can let an office's runs go on past a plan-limit warning until a time they choose, and a run's minute cap no longer counts the time it waited for a plan-limit hold.

Context (found live on 2026-10-23/24): at 80% of the weekly plan dipo held every new session until the reset, three days away. Every new session reports the warning again, so the hold comes back after each session, and the maintainer had no supported way to let dipo go on. A story's fix round waited over two hours for that hold, and the wait counted toward the run's 180-minute time cap, so the story parked `budget-exceeded` with nothing done.

Scope:
- `limits.allow` (office command) and `office.limits` (office read) in the contract; `dipo limits` and `dipo limits allow --until <time> --note <why>` / `--clear` in the CLI.
- The allowance is stored per office (`plan_limit_allowances`, a new migration) with who, when, until and the note, and ends by itself at its time. It lifts the holds of `allowed_warning`s on the weekly, model-family and unknown scopes for that office's new sessions. It never lifts a rejected limit (a worker's wait fact, a reviewer's rejected limit, credits) or a warning on the five-hour session window.
- `until` is at most the latest reset a warning in force names; with no such warning the command is refused (`limits.noWarning`).
- The desk shows an allowance in force as one row.
- Hold waits leave the minute cap: the pre-start cap check of a fix round or conflict hand-off leaves out the current wait for its place, and a run held by its own plan-limit wait adds that wait to `parked_ms` when its next session is recorded.

References: 0008 section 7, 0020, DIPO-61, DIPO-92, DIPO-142, DIPO-205.

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP`.

```dipo
branch: "DIPO-338/allow-past-plan-warning"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a weekly allowed_warning holds the next session; limits.allow lets it start; the allowance ends at its time and by --clear, and the hold is back."
    - kind: "automated"
      check: "(engine) under an allowance a reviewer's rejected limit, a worker's wait fact and a five-hour warning still hold."
    - kind: "automated"
      check: "(engine) a fix round that waited for its place under a hold is not parked budget-exceeded by the pre-start cap check, and a run resumed after its own plan-limit wait has that wait left out of its minute cap."
    - kind: "automated"
      check: "(cli) dipo limits prints the warnings and the allowance; dipo limits allow --until --note and --clear send limits.allow."
    - kind: "manual"
      check: "With a live weekly warning, dipo limits shows it; dipo limits allow --until <reset> --note <why> lets the next session start and dipo desk shows the allowance row."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A contract command and `dipo limits allow --until <time> --note <why>` let the office's runs go on past an `allowed_warning` until the given time (at most the reset the warning names); while it is in force a new warning does not hold sessions; the allowance is stored with who, when, until and the note, ends by itself, and `dipo limits allow --clear` ends it early
- [ ] #2 It never overrides a rejected limit (`rejected`, or the five-hour window), which still holds as today
- [ ] #3 `dipo limits` (or the existing status read) shows the current warning, its utilization and reset, and any allowance; the desk shows an allowance in force as one row
- [ ] #4 Time a run spends waiting for a plan-limit hold (before a session starts or between sessions) does not count toward its minute cap, as paused time already does not
- [ ] #5 Tests cover: a warning held, the allowance letting the next session start, the allowance ending at its time and by `--clear`, a rejected limit still holding under an allowance, and a hold wait left out of the minute cap
<!-- AC:END -->
