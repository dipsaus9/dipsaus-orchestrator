---
id: DIPO-16
title: Bootstrap the Bun workspace with verify and required CI checks
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 09:52'
labels:
  - 'tier:M'
milestone: m-0
dependencies: []
references:
  - package.json
  - bun.lock
  - .bun-version
  - bunfig.toml
  - tsconfig.base.json
  - tsconfig.json
  - .oxlintrc.json
  - .oxfmtrc.json
  - .gitignore
  - packages/
  - scripts/check-pr-title.ts
  - scripts/check-pr-title.test.ts
  - test/lint-boundaries/
  - .github/workflows/ci.yml
  - .github/workflows/pr-title.yml
  - CLAUDE.md
documentation:
  - docs/decisions/0004-language-and-runtime.md
  - docs/decisions/0016-ci-release-and-versioning.md
  - docs/decisions/0017-testing-strategy-and-configuration.md
priority: high
type: chore
ordinal: 16000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the repository is a Bun workspace with the six packages of ADR 0004, a single `bun run verify`, and CI that reports the required checks `ci-ok` and `pr-title`.

Context: there is no code yet. This story sets the floor every later story builds on. Packages hold only an `index.ts` and one test each. References: 0004 "Repo layout", "Tooling and the verify command"; 0016 rule 1 (ci.yml, pr-title.yml), rule 2 (required checks); 0017 section 1 (`DIPO_TEST_CI`, `*.ci.test.ts`), section 4 (`randomize = true`, no retries). The Backlog CLI stays on 1.53.x on every machine (M0 review, D11, DIPO-15; 0016 amendment of 2026-10-12): the repository pins it as a devDependency (DIPO-18) and the maintainer installs the same version globally. Later stories add the packages named in the pinned versions table; this story records the versions.

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-16/bootstrap-bun-workspace-verify-required"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) `check-pr-title` accepts every valid example from 0016 rule 1 and rejects each malformed form (missing scope, wrong type, trailing period, 101-character subject, `Revert \"x\"`)."
    - kind: "automated"
      check: "(unit) oxlint fixtures, one per boundary rule, each reported as an error."
    - kind: "automated"
      check: "(CI) a PR with an invalid title fails `pr-title`; `ci-ok` fails when `verify` fails."
    - kind: "manual"
      check: "open a PR titled `DIPO-99: test`"
      expect: "`pr-title` is red; retitle to `chore(DIPO-99): test` -> `pr-title` is green without rerunning `ci.yml`."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Root `package.json` declares workspaces `packages/*`, `engines.bun` equal to the `.bun-version` floor, and scripts `format:check`, `format:fix`, `lint`, `typecheck`, `test`, `verify`.
- [ ] #2 `bun run verify` runs oxfmt check, oxlint with `--deny-warnings`, `tsc -b` and `bun test`, in that order, and exits non-zero on the first failure.
- [ ] #3 Packages `contract`, `engine`, `daemon`, `client`, `tui`, `cli` exist under `packages/`, each private at version `0.0.0`, scoped `@dipsaus-orchestrator/*`, with an `exports` map exposing only its entry.
- [ ] #4 The oxlint config fails verify when `tui` or `client` imports `engine` or `daemon`, when `cli` imports `engine`, or on any deep import `@dipsaus-orchestrator/*/src/*`; a test runs oxlint on fixture files and asserts each violation is reported.
- [ ] #5 `contract` lists only `zod` as a runtime dependency.
- [ ] #6 `bunfig.toml` sets `randomize = true` and no retry for `bun test`.
- [ ] #7 `.github/workflows/ci.yml` runs on `pull_request` and push to `main` with top-level `permissions: {}`, SHA-pinned actions, `persist-credentials: false`, jobs `verify` (sets `DIPO_TEST_CI=1`), `dependency-review` (PRs only, licence allow list from 0016) and `ci-ok` (`needs` all, `if: always()`).
- [ ] #8 `.github/workflows/pr-title.yml` job `pr-title` runs `bun scripts/check-pr-title.ts` with the title passed through an environment variable, on `opened`, `edited`, `synchronize`, `reopened`.
- [ ] #9 `scripts/check-pr-title.ts` accepts exactly the 0016 rule 1 grammar (types, scopes `DIPO-<n>[.<m>]`, `deps`, `main`, `backlog`, optional `!`, subject 1 to 100 characters without trailing period) and rejects `Revert "..."`.
- [ ] #10 `CLAUDE.md` status section names the workspace and the verify command, and lists the repository settings the maintainer applies by hand: required checks `ci-ok` and `pr-title`, `strict` on, squash title `PR_TITLE`, squash message `BLANK`.
- [ ] #11 `CLAUDE.md` lists the prerequisites, Bun at exactly the `.bun-version` version and the global Backlog CLI installed with `bun add -g backlog.md@1.53.0`, and a pinned versions table: Bun (exact, 1.4.2 per 0004), zod (4.x minor), TypeScript, oxlint, oxfmt, react and ink, and `@anthropic-ai/sandbox-runtime` 0.0.79.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S01 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
