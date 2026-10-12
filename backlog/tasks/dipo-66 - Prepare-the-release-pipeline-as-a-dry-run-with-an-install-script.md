---
id: DIPO-66
title: Prepare the release pipeline as a dry run with an install script
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 09:52'
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
- [ ] #1 `release-please-config.json` and `.release-please-manifest.json` configure one `node` release at the root with `bump-minor-pre-major: true`.
- [ ] #2 `release.yml` on `workflow_dispatch` runs release-please with `--dry-run` and builds `dipo-<os>-<arch>.tar.gz` archives kept as workflow artifacts, with no tag, release or upload.
- [ ] #3 Job permissions match the 0016 rule 1 table; the `release-please` and `release` environments are referenced only by their jobs.
- [ ] #4 `install.sh` (POSIX `sh`) detects OS and architecture, refuses Windows and musl, verifies `SHA256SUMS`, runs the pinned `gh attestation verify` when `gh` exists, installs to `${DIPO_INSTALL_DIR:-$HOME/.local/bin}` by writing a temporary file in that directory and renaming it over any existing binary, and honours `DIPO_VERSION`.
- [ ] #5 CI job `shellcheck` checks `install.sh` and is needed by `ci-ok`.
- [ ] #6 `CLAUDE.md` states that agents and the orchestrator never merge a PR labelled `autorelease: pending` and never approve a deployment, and that each release waits for the maintainer's live smoke run.
- [ ] #7 `README.md` documents both install forms, asset names, the attestation command and the Gatekeeper workaround.
- [ ] #8 `docs/release.md` lists the one-time maintainer steps (GitHub App, environments, tag ruleset, immutable releases, private vulnerability reporting).
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S50 (DIPO-15). After cutover: built by dipo itself, not by a hand-run agent.
<!-- SECTION:NOTES:END -->
