---
id: DIPO-321
title: >-
  Harden the release path: CI cache, lockfile automerge, workflow lint, install
  checks, ignores
status: Refined
assignee: []
created_date: '2026-10-22 21:00'
updated_date: '2026-10-22 21:01'
labels:
  - 'tier:M'
  - release
milestone: m-1
dependencies: []
references:
  - .github/workflows/release.yml
  - .github/workflows/ci.yml
  - .github/workflows/pr-title.yml
  - .github/workflows/audit.yml
  - renovate.json
  - scripts/renovate-config.test.ts
  - scripts/check-pr-title.ts
  - install.sh
  - test/install-script/
  - .gitignore
  - docs/release.md
  - SECURITY.md
  - CLAUDE.md
type: chore
ordinal: 306000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a change to CI, the release workflow, `install.sh` or the release-please config cannot merge on agent review alone. The release build restores no cache that a main build could poison, and checks the Bun it downloads. Lockfile maintenance no longer merges runtime dependency changes unreviewed. Workflows are linted in CI, and the required title check runs no code from the PR it checks. `install.sh` refuses an install it cannot verify unless told to. The repository ignores files that hold secrets. The ignored audit advisory has a tracked end.

Context:
- This story lands before the first real release, v0.1.0.
- **Release build.** `.github/workflows/release.yml` uses setup-bun with its executable cache on and does not check the downloaded Bun.
- **Lockfile maintenance.** `renovate.json` sets `lockFileMaintenance.automerge` to true, beside the one automerge row of 0016 rule 11.
- **Merge review.** There is no CODEOWNERS file and no required human review for `.github/`, `install.sh` or the release-please config (0016). Box parts already refuse `.github/` changes, but other PRs do not.
- **Title check.** No workflow linter runs, and `pr-title.yml` runs the PR's own `scripts/check-pr-title.ts`.
- **Install script.** `install.sh` skips the attestation check when gh is missing, and pins no source digest.
- **Ignores.** `.gitignore` has no patterns for env files, private key files or npm credential files. `docs/release.md` has the maintainer download the release App's private key.
- **Audit.** `.github/workflows/audit.yml` ignores one advisory that does not reach dipo's code path, with no end date and no tracking.

```dipo
branch: "DIPO-321/harden-release-path"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `release.yml` turns setup-bun's cache off and checks the downloaded Bun against a pinned checksum.
- [ ] #2 Lockfile-maintenance PRs do not automerge, and `scripts/renovate-config.test.ts` checks it.
- [ ] #3 A change under `.github/`, to `install.sh` or to the release-please config needs the maintainer's approval before it merges. How (CODEOWNERS with required review, or a required check) is proposed as a dated 0016 note for the maintainer's approval, and the settings list in CLAUDE.md is updated.
- [ ] #4 `pr-title.yml` runs `check-pr-title.ts` from the base branch, never from the PR head.
- [ ] #5 A workflow linter job, pinned by digest, runs in CI and is part of `ci-ok`.
- [ ] #6 Without gh, `install.sh` stops with a message saying how to verify the download, unless an explicit opt-out is set. With gh, it also pins the source digest of the release tag. `docs/release.md` describes both.
- [ ] #7 `.gitignore` ignores env files, private key and certificate files, and npm credential files, and `git ls-files` shows none of them tracked.
- [ ] #8 The advisory ignore in `audit.yml` names its tracking story and the dependency version that ends it.
<!-- AC:END -->
