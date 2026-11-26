---
id: DIPO-514
title: Take the light CI path for a backlog PR that also changes role files
status: Refined
assignee: []
created_date: '2026-11-13 12:21'
updated_date: '2026-11-26 09:25'
labels:
  - tech-debt
  - 'tier:S'
  - 'role:developer'
milestone: m-4
dependencies: []
references:
  - .github/workflows/ci.yml
  - scripts/ci-light-path.test.ts
  - packages/engine/src/backlog/pr/check.ts
  - docs/decisions/0016-ci-release-and-versioning.md
type: chore
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want a backlog PR that changes only stories and role files to take the light CI path so that a confirmed role change merges in minutes.

The changes job sets the light path only when every changed path is backlog/config.yml or backlog/*.md (.github/workflows/ci.yml:63). The planning lane writes role files at .dipo/roles/<name>.md in its backlog PRs (0022 section 2, DIPO-474), so each such PR runs every heavy job. The structural check on the light path already accepts role files whose name matches ^\.dipo/roles/[a-z0-9][a-z0-9-]*\.md$ (packages/engine/src/backlog/pr/check.ts:82-86) and refuses every other path (:241-250). The Ready gate runs on every PR (ci.yml:77-98).

- The case at ci.yml:63 also accepts .dipo/roles/*.md, keeping the mode checks at :61-62. A nested or misnamed path under .dipo/roles/ still takes the light path, but the structural check fails it, so ci-ok fails.
- The comments at ci.yml:16-18 and :33-38 and decision 0016 say the light path covers role files.
- scripts/ci-light-path.test.ts gets the cases.

The change is under .github/, so its PR needs the code owner's hand merge (0002 line 96, 0016 line 65).

## What it does not do
- Does not put .dipo/planning.md or any other .dipo/ file on the light path.
- Does not rename the backlog-only scope.

## ADR lines that change
- docs/decisions/0016-ci-release-and-versioning.md, 1. CI: "When `changes` finds that a PR changes only `backlog/`, the" becomes: When `changes` finds that a PR changes only `backlog/` and role files `.dipo/roles/<name>.md`, the

## Risks and choices
- guard-loosened: A role-file PR skips tests, lint and smoke. The lane already checks that a role file loads, and the structural check refuses other paths.
- other: The change is under .github/, so dipo cannot approve it: the maintainer merges it by hand on GitHub.

```dipo
branch: "DIPO-514/take-light-ci-path-backlog-pr-that-also"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "The changes job on a PR that adds a story and edits .dipo/roles/designer.md outputs backlog-only"
    - kind: "automated"
      check: "The changes job on a PR that edits a role file and packages/engine/src/index.ts outputs full"
    - kind: "automated"
      check: "The changes job on a PR whose role file is a symlink or has mode 100755 outputs full"
    - kind: "automated"
      check: "The structural check on a light-path PR with .dipo/roles/sub/x.md fails, naming the path"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A PR that changes only backlog .md files and .dipo/roles/<name>.md files gets the scope backlog-only.
- [ ] #2 A PR that changes a role file and any file outside backlog/ and .dipo/roles/ gets the scope full.
- [ ] #3 A role file that is a symlink or executable gives the scope full.
- [ ] #4 A light-path PR with a role file whose name the structural check refuses fails ci-ok.
- [ ] #5 Decision 0016 and the comments in ci.yml say the light path covers role files under .dipo/roles/.
<!-- AC:END -->
