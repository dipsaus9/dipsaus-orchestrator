---
id: DIPO-17
title: Build the dipo binary and smoke-test it on four targets
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-11 18:49'
labels:
  - 'tier:S'
milestone: m-0
dependencies:
  - DIPO-16
references:
  - scripts/build.ts
  - scripts/build.test.ts
  - packages/cli/
  - .github/workflows/ci.yml
documentation:
  - docs/decisions/0004-language-and-runtime.md
  - docs/decisions/0016-ci-release-and-versioning.md
priority: high
type: chore
ordinal: 17000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `bun scripts/build.ts --target <t>` produces a signed `dipo` binary that prints its version, and CI smoke-tests it on darwin-arm64, darwin-x64, linux-x64 and linux-arm64.

Context: the CLI has only `--version` and `--help` here; later stories add subcommands. References: 0004 "Tooling" (build row, compile smoke test outside verify); 0016 rule 1 (smoke jobs), rule 5 (`dipo --version`), rule 6 (ad hoc signing).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

```dipo
branch: "DIPO-17/build-dipo-binary-smoke-test-it-four"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) version string formatting from given defines, with and without `-dirty`, and the source fallback."
    - kind: "automated"
      check: "(CI) the four smoke jobs pass on a PR."
    - kind: "manual"
      check: "`bun scripts/build.ts --target bun-darwin-arm64 && ./dist/dipo --version`"
      expect: "prints `dipo 0.0.0-dev (<commit> <date>) bun <v> darwin-arm64`."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `scripts/build.ts` builds `packages/cli` with `bun build --compile --target=bun-<os>-<arch>` and defines `DIPO_VERSION`, `DIPO_COMMIT` (12 hex plus `-dirty` on a dirty tree) and `DIPO_COMMIT_DATE`.
- [ ] #2 Outside a release, the version printed is the `package.json` version with `-dev` appended; running from source without defines prints `dev (unknown commit)`.
- [ ] #3 `dipo --version` prints `dipo <version> (<commit> <date>) bun <bun-version> <os>-<arch>` and `--version --json` prints the same fields as JSON.
- [ ] #4 On darwin, `scripts/build.ts` runs `codesign --sign - --force` when `codesign -v` fails.
- [ ] #5 `ci.yml` has four `smoke (<target>)` jobs on `macos-26`, `macos-26-intel`, `ubuntu-24.04`, `ubuntu-24.04-arm`, each checking `--version`, `--help`, `file` output, `codesign -v` on macOS, and writing the highest `GLIBC_` version to the job summary on Linux.
- [ ] #6 `ci-ok` needs the four smoke jobs.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S02 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
