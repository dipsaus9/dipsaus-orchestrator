---
id: DIPO-17
title: Build the dipo binary and smoke-test it on four targets
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 09:23'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-16
references:
  - scripts/build.ts
  - scripts/build.test.ts
  - packages/cli/
  - .github/workflows/ci.yml
  - packages/daemon/src/
  - packages/engine/src/platform/self-check.ts
  - packages/engine/package.json
  - packages/tui/src/self-check.ts
  - packages/tui/package.json
  - package.json
  - bun.lock
documentation:
  - docs/decisions/0004-language-and-runtime.md
  - docs/decisions/0006-daemon-and-ipc.md
  - docs/decisions/0009-tui.md
  - docs/decisions/0016-ci-release-and-versioning.md
priority: high
type: chore
ordinal: 17000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `bun scripts/build.ts --target <t>` produces a signed `dipo` binary that prints its version, and CI smoke-tests it on darwin-arm64, darwin-x64, linux-x64 and linux-arm64, including a hidden `dipo self-check` of the runtime features the daemon and TUI rely on inside the compiled binary.

Context: the CLI has only `--version`, `--help` and the hidden `self-check` here; later stories add subcommands. The self-check finds a runtime feature that breaks under `bun build --compile` on day one instead of in a later story (M0 review, DIPO-15). Its engine checks run daemon-side through `runDaemon` and `engine/src/platform/` (0004 boundary rules); the Ink check runs through `tui`. The `srt` check only proves the library bundles and initialises; running a command inside it is the `dipo daemon sandbox-exec` form that DIPO-37 builds and adds to these smoke jobs (0004 and 0008 amendments of 2026-10-12). References: 0004 "Tooling" (build row, compile smoke test outside verify) and its 2026-10-12 amendment; 0016 rule 1 (smoke jobs), rule 5 (`dipo --version`), rule 6 (ad hoc signing); 0006 decision 9 (`Bun.serve` on a Unix socket, `ws+unix://`); 0007 section 1 (WAL, `VACUUM INTO` in a Bun Worker); 0009 section 1 (Ink in the compiled binary); 0017 section 5 (`Bun.YAML.parse`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

```dipo
branch: "DIPO-17/build-dipo-binary-smoke-test-it-four"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) version string formatting from given defines, with and without `-dirty`, and the source fallback."
    - kind: "automated"
      check: "(CI) the four smoke jobs pass on a PR, each running `dipo self-check`."
    - kind: "automated"
      check: "(unit) `self-check` names the failing check and exits non-zero when one probe throws."
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
- [ ] #7 The hidden `dipo self-check` opens a `bun:sqlite` database in WAL mode in a temp directory, does a round trip with a Bun Worker passed to `bun build --compile` as an extra entrypoint, serves `Bun.serve` on a Unix socket and connects to it with a `ws+unix://` client, parses YAML with `Bun.YAML.parse`, renders an Ink component to a PassThrough stream, and initialises the bundled `@anthropic-ai/sandbox-runtime` library with a deny-all policy; it prints one line per check and exits non-zero on the first failure.
- [ ] #8 Ink's optional `react-devtools-core` peer dependency is handled so the compiled binary builds and runs without it, and any other unresolved import fails the build.
- [ ] #9 Each of the four smoke jobs runs `dipo self-check` and fails when it exits non-zero.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S02 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
