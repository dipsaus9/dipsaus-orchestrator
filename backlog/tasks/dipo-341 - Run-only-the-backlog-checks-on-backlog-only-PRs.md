---
id: DIPO-341
title: Run only the backlog checks on backlog-only PRs
status: Refined
assignee: []
created_date: '2026-10-25 09:50'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:1'
milestone: m-1
dependencies: []
references:
  - .github/workflows/ci.yml
  - scripts/check-ready-gate.ts
  - scripts/check-backlog-pr.ts
priority: high
type: chore
ordinal: 321000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a pull request that changes only backlog/ passes ci-ok within minutes, running only the Ready gate, the structural check and the PR title check, while every other PR still runs the full CI.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. Removes the full CI run on backlog-only PRs (0016, 0010). .github/ is the release path, so the maintainer merges this PR by hand.

```dipo
branch: "DIPO-341/light-ci-backlog-prs"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the path classifier returns backlog-only for backlog paths only, and full for a mixed or empty list"
    - kind: "manual"
      check: "Open a PR that only edits a backlog task"
      expect: "ci-ok is green within five minutes and only ready-gate and pr-title ran"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A changes job in ci.yml finds a PR whose changed paths are all under backlog/, and on such a PR verify, verify-macos, smoke, shellcheck, actionlint and dependency-review are skipped by design
- [ ] #2 A ready-gate job runs scripts/check-ready-gate.ts and the 0010 structural check (scripts/check-backlog-pr.ts) on every story the PR changes, and ci-ok needs it
- [ ] #3 ci-ok passes on a backlog-only PR whose heavy jobs were skipped by the changes job, and fails when a job failed or was skipped for any other reason
- [ ] #4 A PR that changes any file outside backlog/, and every push to main, run every job as before
<!-- AC:END -->
