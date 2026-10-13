---
id: DIPO-66
title: Prepare the release pipeline as a dry run with an install script
status: In Progress
assignee:
  - '@claude'
created_date: '2026-10-11 18:48'
updated_date: '2026-10-13 12:04'
labels:
  - 'tier:M'
  - after-cutover
milestone: m-0
dependencies:
  - DIPO-17
references:
  - .github/workflows/release.yml
  - .github/workflows/ci.yml
  - release-please-config.json
  - .release-please-manifest.json
  - install.sh
  - README.md
  - CLAUDE.md
  - docs/release.md
documentation:
  - docs/decisions/0016-ci-release-and-versioning.md
  - docs/decisions/0017-testing-strategy-and-configuration.md
priority: medium
type: chore
ordinal: 66000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `release.yml` runs release-please and the four-target release build as a dry run on `workflow_dispatch` that publishes nothing, `install.sh` installs a release with checksum and attestation checks, and `shellcheck` joins CI, so `v0.1.0` needs only the one approved switch.

Context: replacing the binary by rename keeps a running daemon on its open file and never leaves a half-written binary (M0 review, DIPO-15; 0006 decision 14). References: 0016 rules 1 (shellcheck job), 3 (release-please, App token, `bump-minor-pre-major`, dry run until `v0.1.0`), 4 (environments, build, publish, attestations, post-release check), 7 (install script), 12 (autorelease rule in `CLAUDE.md`); 0017 section 1 and 0016 amendment (live smoke run before release).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

Built after cutover: dipo delivers this story itself (M0 review decision D14, DIPO-15).

```dipo
branch: "DIPO-66/prepare-release-pipeline-as-dry-run"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(CI) `shellcheck` passes."
    - kind: "manual"
      check: "run `release.yml` with `workflow_dispatch`"
      expect: "the summary shows the proposed version and changelog; four archives are attached as artifacts; no tag or release exists."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `release-please-config.json` and `.release-please-manifest.json` configure one `node` release at the root with `bump-minor-pre-major: true`.
- [x] #2 `release.yml` on `workflow_dispatch` runs release-please with `--dry-run` and builds `dipo-<os>-<arch>.tar.gz` archives kept as workflow artifacts, with no tag, release or upload.
- [x] #3 Job permissions match the 0016 rule 1 table; the `release-please` and `release` environments are referenced only by their jobs.
- [x] #4 `install.sh` (POSIX `sh`) detects OS and architecture, refuses Windows and musl, verifies `SHA256SUMS`, runs the pinned `gh attestation verify` when `gh` exists, installs to `${DIPO_INSTALL_DIR:-$HOME/.local/bin}` by writing a temporary file in that directory and renaming it over any existing binary, and honours `DIPO_VERSION`.
- [x] #5 CI job `shellcheck` checks `install.sh` and is needed by `ci-ok`.
- [x] #6 `CLAUDE.md` states that agents and the orchestrator never merge a PR labelled `autorelease: pending` and never approve a deployment, and that each release waits for the maintainer's live smoke run.
- [x] #7 `README.md` documents both install forms, asset names, the attestation command and the Gatekeeper workaround.
- [x] #8 `docs/release.md` lists the one-time maintainer steps (GitHub App, environments, tag ruleset, immutable releases, private vulnerability reporting).
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S50 (DIPO-15). After cutover: built by dipo itself, not by a hand-run agent.

Scope additions:
- `.github/actions/smoke/action.yml`: the CI smoke steps moved into one composite action, used by the `smoke (*)` jobs in ci.yml and the `build (*)` jobs in release.yml, so the release build runs the same smoke test as CI (0016 rule 4) without a second copy. CI on this PR runs it on all four targets.
- `test/install-script/install.test.ts`: local tests of install.sh under /bin/sh with stubbed `uname`, `curl`, `ldd`, `sysctl` and `gh` on a PATH-only sandbox, fake archives and SHA256SUMS under DIPO_TMP (about 1.2 s).

Implementation notes:
- release-please dry run uses the CLI (`npx release-please@17.11.2 release-pr|github-release --dry-run`) because the action has no dry-run mode; it needs Node 22+, so the job runs actions/setup-node v7.0.0.
- The dry-run release-please job uses the App token from environment `release-please`, scoped to read-only (`permission-contents/pull-requests: read`), so its permissions match the 0016 rule 1 table (GITHUB_TOKEN none). The maintainer must create the App and the `release-please` environment before the first dry run.
- `publish` and `post-release` are written but run only when `release-please` outputs `publish == true`, which it never does while `DRY_RUN: "true"`. The switch to real releases: `DRY_RUN: "false"` plus `push: branches: [main]`.
- The release build has no dependency cache (installs from bun.lock only).
- shellcheck is not installed locally; a scratchpad copy of shellcheck 0.11.0 and actionlint 1.7.12 found no issues in install.sh, ci.yml, release.yml or the existing stub-worker.sh.
<!-- SECTION:NOTES:END -->
