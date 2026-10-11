---
id: DIPO-33
title: Scan the repository into a run profile and rescan on change
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-11 18:49'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-22
  - DIPO-31
references:
  - packages/engine/src/scan/
  - packages/engine/src/db/migrations/
  - packages/cli/src/
  - packages/engine/test/scan/
documentation:
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0007-state-database.md
  - docs/decisions/0013-repo-scan-and-script-standard.md
priority: high
type: feature
ordinal: 33000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine scans an office's base checkout with pure detection code into a run profile (toolchain, capabilities with source and confidence, env files, dev ports, conformance and deviations), stores it with a fingerprint, rescans when the fingerprint changes, and offers `dipo office rescan` with a diff.

Context: M0 detection is code only; the AI fallback and the confirmation command are M1 (M0 breakdown decision D8, DIPO-15). `run` refuses an office whose verify is unresolved, with a message naming the script to add. This repository resolves verify from its root `verify` script. References: 0013 sections 1 (standard scripts), 2 (levels, `run` refusal), 3 (detection order, conflicts as findings), 4 (stored data, no env contents), 5 (fingerprint, triggers, story-branch scan rule), 7 (env files and ports); 0007 section 4 (`scans`, `run_profiles`, `run_capabilities`, `run_env_files`, `run_ports`, `run_extra_scripts`); 0005 (`office.rescan`, `scan.finished`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

```dipo
branch: "DIPO-33/scan-repository-into-run-profile-rescan"
unknowns:
  - q: "Scope of the AI fallback and confirmation in M0?"
    status: "resolved"
    answer: "maintainer decision D8 of the M0 breakdown (2026-10-11, recorded in DIPO-15): M0 scan is code only; `run` refuses an office whose verify is unresolved with a message naming the script to add; the AI fallback and the confirm command are M1."
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) `detect` over probes shaped like the nine surveyed repositories in 0013 gives the levels in its fit table."
    - kind: "automated"
      check: "(unit) fingerprint unchanged by a lockfile content change, changed by a script change."
    - kind: "automated"
      check: "(integration) scan this repository's shape in a temp repo; verify resolves from the `verify` script."
    - kind: "automated"
      check: "(engine) rescan after a script change stores a diff and emits `scan.finished`."
    - kind: "automated"
      check: "(unit) a probe with no `verify` script, no declared list and none of `lint`, `typecheck`, `test` leaves verify unresolved, and the refusal message names the script to add."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `detect(probe)` is pure: filesystem facts in, profile out, and it runs no repository script.
- [ ] #2 Package manager, install, runtime version, standard scripts, verify (script, declared list, composed from `lint`, `typecheck`, `test`) and dev ports resolve in the 0013 section 3 order with source and confidence.
- [ ] #3 Two lockfiles, a `packageManager` that disagrees with the lockfile, or a `verify` script next to a different declared verify list become findings, never silent choices.
- [ ] #4 Env example files and their expected real files are recorded by path with presence and ignore status; no env file content or hash is read or stored.
- [ ] #5 The fingerprint hashes exactly the inputs of 0013 section 5 and ignores lockfile contents.
- [ ] #6 The fingerprint is computed on `_base` at office load and before each `work.run`; a mismatch re-runs detection and stores the diff against the previous profile.
- [ ] #7 `office.rescan` returns `{ scan: "started" }`, fails with `scan.running` while one runs, and emits `scan.finished` with scripts and warnings; `dipo office rescan` prints the diff.
- [ ] #8 The conformance level and each deviation are stored and printed.
- [ ] #9 A profile whose verify is unresolved marks the office not runnable with a message naming the script to add (`verify` in `package.json`, or the 0013 equivalent); no model is called.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S18 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
