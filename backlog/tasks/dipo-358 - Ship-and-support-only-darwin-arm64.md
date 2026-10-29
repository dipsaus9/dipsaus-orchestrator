---
id: DIPO-358
title: Ship and support only darwin-arm64
status: Done
assignee: []
created_date: '2026-10-25 09:52'
updated_date: '2026-10-29 09:05'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-351
references:
  - .github/workflows/release.yml
  - .github/workflows/ci.yml
  - .github/actions/smoke/
  - scripts/build.ts
  - install.sh
  - packages/client/src/node/lifecycle/
  - packages/engine/src/platform/
  - packages/engine/src/keepawake/
priority: medium
type: chore
ordinal: 338000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: releases build and smoke-test only darwin-arm64, install.sh refuses other platforms, and the systemd units and scopes, systemd-inhibit, bwrap and the Linux lingering checks are removed, with Linux kept only as a CI host for tests.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. Maintainer decision of 2026-10-24 (audit question 2; 0004, 0016). .github/ and install.sh are the release path, so the maintainer merges this PR by hand.

```dipo
branch: "DIPO-358/darwin-arm64-only"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) scripts/build.ts knows only the darwin-arm64 target"
    - kind: "manual"
      check: "Run install.sh on the Mac"
      expect: "dipo installs and dipo --version prints darwin-arm64"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 release.yml and the smoke jobs build and test darwin-arm64 only
- [x] #2 install.sh refuses anything but macOS on Apple silicon with a clear message
- [x] #3 The systemd and Linux code paths of the client lifecycle, keep-awake and platform modules are removed, and the Linux CI verify job still passes
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Releases and CI smoke build and test darwin-arm64 only (scripts/build.ts, release.yml, the smoke action); release.yml stays a workflow_dispatch dry run. install.sh refuses anything but macOS on Apple silicon before any download, allowing a Rosetta shell on Apple silicon. The systemd unit, lingering checks, systemd-inhibit, systemd scopes, dipo daemon wait-pid and the Linux state and runtime folders are removed; Linux stays a CI host, keeping the process probe and mountinfo reader, and the compiled-binary lifecycle test runs on macOS only. No default path changes on macOS. ADR 0004, CLAUDE.md, README and docs/release.md updated.
<!-- SECTION:FINAL_SUMMARY:END -->
