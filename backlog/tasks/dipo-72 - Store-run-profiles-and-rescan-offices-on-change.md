---
id: DIPO-72
title: Store run profiles and rescan offices on change
status: To Do
assignee: []
created_date: '2026-10-12 09:21'
updated_date: '2026-10-12 12:21'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-22
  - DIPO-27
  - DIPO-31
  - DIPO-32
  - DIPO-33
references:
  - packages/engine/src/scan/
  - packages/engine/src/db/migrations/
  - packages/engine/src/features.ts
  - packages/cli/src/
  - packages/engine/test/scan/
documentation:
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0007-state-database.md
  - docs/decisions/0013-repo-scan-and-script-standard.md
priority: high
type: feature
ordinal: 33500
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine stores each office's run profile with its fingerprint, rescans when the fingerprint on `_base` changes, offers `office.rescan` and `dipo office rescan` with a diff, and reports an office whose verify is unresolved as not runnable with the script to add.

Context: split from DIPO-33 in the M0 review (DIPO-15); DIPO-33 keeps the pure detection. M0 scan is code only (M0 breakdown decision D8, DIPO-15). The scan at office load is an office load step and `office.rescan` a command, both added through the registration seams of DIPO-22 and DIPO-27 (`register(registry)` listed in `packages/engine/src/features.ts`), not by editing `commands/` or `office/`. References: 0013 sections 2 (`run` refusal), 4 (stored data, no env contents), 5 (fingerprint, triggers, story-branch scan rule); 0007 section 4 (`scans`, `run_profiles`, `run_capabilities`, `run_env_files`, `run_ports`, `run_extra_scripts`); 0005 (`office.rescan`, `scan.running`, `scan.finished`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-72/store-run-profiles-rescan-offices-change"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) rescan after a script change stores a diff and emits `scan.finished`."
    - kind: "automated"
      check: "(engine) a second `office.rescan` while one runs fails with `scan.running`."
    - kind: "automated"
      check: "(engine) an office without a resolvable verify gets a refusal from `verifyResolved` naming `verify` in `package.json`."
    - kind: "automated"
      check: "(engine) an unchanged fingerprint before `work.run` runs no detection."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Migrations add `scans`, `run_profiles`, `run_capabilities`, `run_env_files`, `run_ports` and `run_extra_scripts` with the columns of 0007 section 4.
- [ ] #2 The fingerprint is computed on `_base` as an office load step and by `ensureFreshProfile(office)` before each `work.run`; a mismatch runs detection (DIPO-33) and stores the new profile with its diff against the previous one.
- [ ] #3 `office.rescan` returns `{ scan: "started" }`, fails with `scan.running` while one runs, re-indexes stories (DIPO-32), and emits `scan.finished` with scripts and warnings.
- [ ] #4 `dipo office rescan` prints the diff, the conformance level and each deviation.
- [ ] #5 `verifyResolved(office)` returns the refusal message of a profile whose verify is unresolved, for `work.run` (DIPO-48) to use; no model is called.
- [ ] #6 The fingerprint also hashes the local config modules a dev server config imports when ports are read from them (0013 amendment of 2026-10-12); a test shows a port change in such a module changes the fingerprint and triggers a rescan.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Split from DIPO-33 in the M0 review (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
