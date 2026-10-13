---
id: DIPO-67
title: 'Configure Renovate, audit and the security policy'
status: Done
assignee:
  - '@claude'
created_date: '2026-10-11 18:48'
updated_date: '2026-10-13 11:59'
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
- [x] #1 `renovate.json` sets `config:recommended`, `helpers:pinGitHubActionDigests`, semantic commits, weekly schedule, `minimumReleaseAge` 3 days, the three groups, vulnerability alerts on, and monthly lockfile maintenance.
- [x] #2 Automerge is off globally and on only for devDependency minor and patch updates and lockfile maintenance; the Bun group, actions, runtime dependencies, `backlog.md`, majors and vulnerability PRs never automerge.
- [x] #3 `audit.yml` runs `bun audit --audit-level=high` on PRs touching `bun.lock` and daily; a failing scheduled run opens or updates one issue labelled `security`; it is not a required check.
- [x] #4 `SECURITY.md` points to private vulnerability reporting.
- [x] #5 A test in `scripts/check-runtime-imports.test.ts` reads every import in `packages/*/src` and fails when an imported package is not a runtime dependency of that package's `package.json`.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S51 (DIPO-15). After cutover: built by dipo itself, not by a hand-run agent.

Scope additions: none. Every changed file is in References; .oxlintrc.json needed no change (the devDependency import ban is the test script).
Implementation: renovate.json (AC #1, #2) checked by scripts/renovate-config.test.ts, which replays packageRules in order per update kind and refuses matchers it cannot replay; config also validated with renovate-config-validator --strict (renovate@latest, local run). backlog.md: allowedVersions 1.53.x plus automerge false. audit.yml (AC #3): audit job contents: read, report job issues: write on scheduled failures only; it creates the security label when missing; workflow_dispatch added for a manual run (report does not run on it). SECURITY.md (AC #4). scripts/check-runtime-imports.test.ts (AC #5): Bun.Transpiler.scanImports over packages/*/src, test files excepted; passes on main with no violations.
Finding: bun audit --audit-level=high fails on main today: node-forge 1.4.0 (GHSA-86w9-cpqp-85rv, high) via @anthropic-ai/sandbox-runtime 0.0.79 in engine. Not changed here; the first daily run will open the security issue.
AC #3 CI proof (a PR touching bun.lock) is not exercised by this PR, which does not change bun.lock.

Maintainer decision (2026-10-13): audit.yml ignores GHSA-86w9-cpqp-85rv (node-forge <=1.4.0 via @anthropic-ai/sandbox-runtime 0.0.79; no fixed release exists). Remove the ignore once a fix ships. The story's own task file is bookkeeping outside References.
<!-- SECTION:NOTES:END -->
