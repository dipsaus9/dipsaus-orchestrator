---
id: DIPO-13
title: 'Decide CI, release and versioning'
status: In Progress
assignee: []
created_date: '2026-10-10 11:03'
updated_date: '2026-10-10 11:21'
labels:
  - architecture
milestone: m-0
dependencies:
  - DIPO-1
priority: high
type: spike
ordinal: 13000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an ADR defining how the project is built, checked and released, on the stack from ADR 0004 (TypeScript on Bun, single binary dipo, macOS and Linux). Cover: GitHub Actions running bun run verify on every PR and as a required status check on main; the compile smoke test for every release target (darwin-arm64, darwin-x64, linux-x64, linux-arm64); producing and publishing binaries to GitHub Releases with checksums; version numbers and changelog (for example semantic versioning with a changeset or conventional-commit tool); a later Homebrew tap; pinned Bun version in CI; dependency updates (Renovate or Dependabot) and basic security scanning; who or what may publish a release.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 ADR docs/decisions/0016-ci-release-and-versioning.md records the CI workflow, required checks and their place in branch protection
- [x] #2 ADR defines the release flow: versioning, changelog, building binaries for every target, checksums, publishing to GitHub Releases, and the later Homebrew tap
- [x] #3 ADR defines dependency update and security scanning tooling and how their PRs are reviewed and merged
- [ ] #4 Maintainer approved the decision
- [x] #5 ADR decides macOS code signing and notarization (or documents the Gatekeeper workaround), the install path from GitHub Releases (install script or manual), version and commit embedding for dipo --version, and glibc versus musl Linux targets
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Draft ADR 0016 by research agent. Review 1: block (release App key location) plus 7 advisories, fixed. Review 2: pass, 5 security advisories applied (pinned attestation verification, no admin bypass, workflow PRs maintainer-merged pending approval). Waiting for maintainer approval.
<!-- SECTION:NOTES:END -->
