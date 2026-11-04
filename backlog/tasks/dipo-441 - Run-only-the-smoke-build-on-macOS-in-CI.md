---
id: DIPO-441
title: Run only the smoke build on macOS in CI
status: Refined
assignee: []
created_date: '2026-11-04 12:24'
labels:
  - 'tier:S'
milestone: m-2
dependencies: []
references:
  - .github/workflows/ci.yml
  - scripts/test-shards.ts
  - scripts/test-shards.test.ts
  - scripts/ci-light-path.test.ts
  - docs/decisions/0016-ci-release-and-versioning.md
  - CLAUDE.md
priority: high
type: chore
ordinal: 414000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want CI on macOS cut to the smoke build so that parallel pull requests stop failing on macOS test jobs that wait for a runner and get cancelled.

Maintainer's decision, planning interview 2026-11-04. Blocks M2: with several stories at once, their pull requests queue on macOS.

The verify-macos job runs the whole suite in four shards on macos-26 (0016). On 2026-11-03 its jobs waited for each other and were cancelled at the 15-minute limit, which counts waiting time, so ci-ok went red with no real failure. The tests run on Linux in verify; the smoke job keeps building and signing the binary on macOS. Box tests already run only by hand (0017).

The change removes the verify-macos job, its place in ci-ok's needs and in the test-shards check, and updates 0016 (with one Replaced line) and the CI paragraph in CLAUDE.md. It touches .github/, so the maintainer approves it as Code Owner. A builder builds it, not dipo.

```dipo
branch: "DIPO-441/macos-ci-smoke-only"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) scripts/test-shards.test.ts: the shard check covers only the Linux verify shards and still fails when a test file is in no shard"
    - kind: "automated"
      check: "(unit) scripts/ci-light-path.test.ts passes unchanged: backlog-only pull requests keep the light path"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 ci.yml has no verify-macos job, ci-ok no longer needs it, and the smoke (darwin-arm64) job stays
- [ ] #2 The test-shards check covers only the Linux verify shards and still fails when a test file is in no shard
- [ ] #3 ADR 0016 and the CI paragraph in CLAUDE.md describe CI without macOS tests, and 0016's Replaced list says why in one line
- [ ] #4 Backlog-only pull requests keep the light path
<!-- AC:END -->
