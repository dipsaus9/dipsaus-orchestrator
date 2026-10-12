---
id: DIPO-33
title: Detect the run profile of a repository with pure scan code
status: Done
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 11:59'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-18
references:
  - packages/engine/src/scan/detect/
  - packages/engine/test/scan/
  - packages/engine/src/platform/repo-files.ts
documentation:
  - docs/decisions/0013-repo-scan-and-script-standard.md
priority: high
type: feature
ordinal: 33000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: pure detection code turns the filesystem facts of a checkout into a run profile (toolchain, capabilities with source and confidence, env files, dev ports, fingerprint, conformance and deviations), and a profile whose verify is unresolved carries a refusal message naming the script to add.

Context: M0 detection is code only; the AI fallback and the confirmation command are M1 (M0 breakdown decision D8, DIPO-15). Storing profiles, rescans, `office.rescan` and `dipo office rescan` were split into DIPO-72 in the M0 review (DIPO-15); `work.run` uses the refusal through DIPO-72. This repository resolves verify from its root `verify` script. References: 0013 sections 1 (standard scripts), 2 (levels, `run` refusal), 3 (detection order, conflicts as findings), 4 (stored data, no env contents), 5 (fingerprint inputs), 7 (env files and ports).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

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
      check: "(integration) `readProbe` plus `detect` over this repository's shape in a temp repo; verify resolves from the `verify` script."
    - kind: "automated"
      check: "(unit) a probe with no `verify` script, no declared list and none of `lint`, `typecheck`, `test` leaves verify unresolved, and the refusal message names the script to add."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `detect(probe)` is pure: filesystem facts in, profile out, and it runs no repository script.
- [x] #2 `readProbe(dir)` collects exactly the file facts `detect` and the fingerprint need, reads no env file content, and runs no repository script.
- [x] #3 Package manager, install, runtime version, standard scripts, verify (script, declared list, composed from `lint`, `typecheck`, `test`) and dev ports resolve in the 0013 section 3 order with source and confidence.
- [x] #4 Two lockfiles, a `packageManager` that disagrees with the lockfile, or a `verify` script next to a different declared verify list become findings, never silent choices.
- [x] #5 Env example files and their expected real files are recorded by path with presence and ignore status; no env file content or hash is read or stored.
- [x] #6 The fingerprint hashes exactly the inputs of 0013 section 5 and ignores lockfile contents.
- [x] #7 The profile carries the conformance level and each deviation.
- [x] #8 A profile whose verify is unresolved carries a refusal message naming the script to add (`verify` in `package.json`, or the 0013 equivalent); no model is called.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S18 (DIPO-15). Before cutover: built by hand-run agents.

Added reference packages/engine/src/platform/repo-files.ts: readProbe must list repository files and ask git which env files it ignores (git ls-files, git check-ignore), which needs a subprocess and filesystem reads. The inherited rule keeps Bun APIs inside packages/engine/src/platform/, so that I/O lives in a new platform module; scan/detect stays pure and receives it by injection.

Implemented in packages/engine/src/scan/detect/ (types, manifest, probe, detect, ports, fingerprint, index) with unit tests beside the code, integration tests in packages/engine/test/scan/, and the injected file facts in packages/engine/src/platform/repo-files.ts (git ls-files and git check-ignore with core.fsmonitor off, so no repository command runs).
- detect(probe, { nothingToStart }) is pure; the profile holds fingerprint, toolchain, capabilities as Resolution (resolved with source, confidence and evidence, conflict with candidates, or unresolved), extra scripts, env files, dev ports, conformance level with deviations, and runRefusal. Scan time and commit are left to DIPO-72, which stores the profile.
- A package manager conflict (two lockfiles, packageManager against the lockfile) puts every package-manager-dependent capability in conflict instead of choosing one.
- Env files: env paths are computed before anything is read and the reader refuses them, so even a gitignored wrangler.toml next to wrangler.example.toml is never read.
- Couchcade: open question 5 (fixed dev ports mean Partial) is applied over the fit table's 'Conforming, with deviations'; the survey test documents this. The blog repo comes out non-standard (fit table: not a product).
- Dev ports: explicit port in the dev script or vite/wrangler config, including a member of a ports object in a module the vite config imports (relative or workspace package export); else the Vite, Next or wrangler default. Imported config modules are read for ports but are not fingerprint inputs, as 0013 section 5 lists none.
- packages/engine/test/ is run by bun test but not by tsc -b (the engine tsconfig includes src only); the integration test was typechecked ad hoc.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Pure repository scan in packages/engine/src/scan/detect: readProbe (via platform/repo-files.ts, git with core.fsmonitor off, env file contents never read) collects manifests, lockfile names, runtime files, dev config and env file presence; detect() resolves package manager, install, runtime, scripts, verify and ports with source, confidence and evidence, reports conflicts, conformance level and deviations, and a runRefusal naming the missing script; fingerprint() hashes the 0013 section 5 inputs, not lockfile contents. Survey: couchcade is Partial (fixed ports, 0013 open question 5). Reviewer pass.
<!-- SECTION:FINAL_SUMMARY:END -->
