---
id: DIPO-321
title: >-
  Harden the release path: CI cache, lockfile automerge, workflow lint, install
  checks, ignores
status: Done
assignee: []
created_date: '2026-10-22 21:00'
updated_date: '2026-10-23 11:33'
labels:
  - 'tier:M'
  - release
milestone: m-1
dependencies: []
references:
  - '- .github/workflows/release.yml'
  - .github/CODEOWNERS
  - .github/workflows/audit.yml
  - .github/workflows/ci.yml
  - .github/workflows/pr-title.yml
  - .github/workflows/release.yml
  - .gitignore
  - CLAUDE.md
  - SECURITY.md
  - docs/decisions/0016-ci-release-and-versioning.md
  - docs/release.md
  - install.sh
  - renovate.json
  - scripts/check-pr-title.ts
  - scripts/release-path.test.ts
  - scripts/renovate-config.test.ts
  - test/install-script/
  - test/install-script/install.test.ts
type: chore
ordinal: 306000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: changes to the release path (CI, the release workflow, `install.sh` and the release-please config) need a maintainer review before they merge. The release build uses a verified Bun and no restored cache. Lockfile maintenance is not merged automatically. Workflows are linted in CI, and the title check runs only code from the base branch. `install.sh` always verifies what it installs, unless told not to. The repository ignores files that hold secrets. Every ignored audit advisory has a tracked end.

Context:
- This story lands before the first real release, v0.1.0.
- The release path is the workflows under `.github/workflows/` (`release.yml`, `ci.yml`, `pr-title.yml`, `audit.yml`), `renovate.json`, `install.sh`, the release-please config and `docs/release.md` (0016).
- Automerge stays limited to the one row of 0016 rule 11.
- Box parts refuse `.github/` changes (DIPO-273); this story gives every PR to the release path the same maintainer review.
- `docs/release.md` covers the release App's private key, which the ignore patterns of criterion 7 keep out of the repository.

```dipo
branch: "DIPO-321/harden-release-path"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The release build in `release.yml` restores no setup-bun cache and checks the Bun it downloads against a pinned checksum.
- [x] #2 Lockfile-maintenance PRs do not automerge, and `scripts/renovate-config.test.ts` checks it.
- [x] #3 A change under `.github/`, to `install.sh` or to the release-please config needs the maintainer's approval before it merges. How (CODEOWNERS with required review, or a required check) is proposed as a dated 0016 note for the maintainer's approval, and the settings list in CLAUDE.md is updated.
- [x] #4 `pr-title.yml` runs `check-pr-title.ts` from the base branch, never from the PR head.
- [x] #5 A workflow linter job, pinned by digest, runs in CI and is part of `ci-ok`.
- [x] #6 Without gh, `install.sh` stops with a message saying how to verify the download, unless an explicit opt-out is set. With gh, it also pins the source digest of the release tag. `docs/release.md` describes both.
- [x] #7 `.gitignore` ignores env files, private key and certificate files, and npm credential files, and `git ls-files` shows none of them tracked.
- [x] #8 Every advisory ignore in `audit.yml` names its tracking story and the dependency version that ends it.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Done 2026-10-23 (maintainer session): built outside dipo, reviewed by a separate agent (all 8 criteria met; its scope findings are closed by these References). Criterion 3: the maintainer chose code owners plus a ruleset (0016 amendment of 2026-10-23, CLAUDE.md settings list); the maintainer applies the ruleset by hand after this merges. The audit ignore's tracking story is DIPO-329. Follow-up DIPO-331: the merge slot holds story PRs that touch the release path for the maintainer.
<!-- SECTION:NOTES:END -->
