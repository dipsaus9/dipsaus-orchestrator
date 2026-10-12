---
id: DIPO-67
title: 'Configure Renovate, audit and the security policy'
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 09:52'
labels:
  - 'tier:S'
  - after-cutover
milestone: m-0
dependencies:
  - DIPO-16
references:
  - renovate.json
  - .github/workflows/audit.yml
  - SECURITY.md
  - .oxlintrc.json
  - scripts/renovate-config.test.ts
  - scripts/check-runtime-imports.test.ts
documentation:
  - docs/decisions/0016-ci-release-and-versioning.md
priority: medium
type: chore
ordinal: 67000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: Renovate keeps dependencies, `.bun-version` and action digests current under the 0016 automerge rules, `audit.yml` runs `bun audit` on lockfile changes and daily, and `SECURITY.md` describes private reporting.

Context: `backlog.md` stays on 1.53.x and never automerges, because the engine refuses any other Backlog CLI version and an update means re-recording the parser fixtures (maintainer decision D11, DIPO-15; 0016 amendment of 2026-10-12). References: 0016 rules 1 (`audit.yml`), 10 (Renovate config, CodeQL default setup), 11 (bot PR review contract) and the 2026-10-12 amendment. The devDependency import ban is a plain test script rather than an oxlint rule, because oxlint support for it is not confirmed (M0 review, DIPO-15).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

Built after cutover: dipo delivers this story itself (M0 review decision D14, DIPO-15).

```dipo
branch: "DIPO-67/configure-renovate-audit-security-policy"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(CI) `audit.yml` runs on a PR that touches `bun.lock`."
    - kind: "automated"
      check: "(unit) a test reads `renovate.json` and fails when any rule enables automerge for `backlog.md`."
    - kind: "automated"
      check: "(unit) the runtime-import check reports a fixture source file that imports a devDependency."
    - kind: "manual"
      check: "open the Renovate onboarding PR"
      expect: "the config validation passes and the dashboard lists the three groups."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `renovate.json` sets `config:recommended`, `helpers:pinGitHubActionDigests`, semantic commits, weekly schedule, `minimumReleaseAge` 3 days, the three groups, vulnerability alerts on, and monthly lockfile maintenance.
- [ ] #2 Automerge is off globally and on only for devDependency minor and patch updates and lockfile maintenance; the Bun group, actions, runtime dependencies, `backlog.md`, majors and vulnerability PRs never automerge.
- [ ] #3 `audit.yml` runs `bun audit --audit-level=high` on PRs touching `bun.lock` and daily; a failing scheduled run opens or updates one issue labelled `security`; it is not a required check.
- [ ] #4 `SECURITY.md` points to private vulnerability reporting.
- [ ] #5 A test in `scripts/check-runtime-imports.test.ts` reads every import in `packages/*/src` and fails when an imported package is not a runtime dependency of that package's `package.json`.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S51 (DIPO-15). After cutover: built by dipo itself, not by a hand-run agent.
<!-- SECTION:NOTES:END -->
