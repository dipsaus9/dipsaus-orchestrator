---
id: DIPO-16
title: Bootstrap the Bun workspace with verify and required CI checks
status: Done
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 11:18'
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
- [x] #1 Root `package.json` declares workspaces `packages/*`, `engines.bun` equal to the `.bun-version` floor, and scripts `format:check`, `format:fix`, `lint`, `typecheck`, `test`, `verify`.
- [x] #2 `bun run verify` runs oxfmt check, oxlint with `--deny-warnings`, `tsc -b` and `bun test`, in that order, and exits non-zero on the first failure.
- [x] #3 Packages `contract`, `engine`, `daemon`, `client`, `tui`, `cli` exist under `packages/`, each private at version `0.0.0`, scoped `@dipsaus-orchestrator/*`, with an `exports` map exposing only its entry.
- [x] #4 The oxlint config fails verify when `tui` or `client` imports `engine` or `daemon`, when `cli` imports `engine`, or on any deep import `@dipsaus-orchestrator/*/src/*`; a test runs oxlint on fixture files and asserts each violation is reported.
- [x] #5 `contract` lists only `zod` as a runtime dependency.
- [x] #6 `bunfig.toml` sets `randomize = true` and no retry for `bun test`.
- [x] #7 `.github/workflows/ci.yml` runs on `pull_request` and push to `main` with top-level `permissions: {}`, SHA-pinned actions, `persist-credentials: false`, jobs `verify` (sets `DIPO_TEST_CI=1`), `dependency-review` (PRs only, licence allow list from 0016) and `ci-ok` (`needs` all, `if: always()`).
- [x] #8 `.github/workflows/pr-title.yml` job `pr-title` runs `bun scripts/check-pr-title.ts` with the title passed through an environment variable, on `opened`, `edited`, `synchronize`, `reopened`.
- [x] #9 `scripts/check-pr-title.ts` accepts exactly the 0016 rule 1 grammar (types, scopes `DIPO-<n>[.<m>]`, `deps`, `main`, `backlog`, optional `!`, subject 1 to 100 characters without trailing period) and rejects `Revert "..."`.
- [x] #10 `CLAUDE.md` status section names the workspace and the verify command, and lists the repository settings the maintainer applies by hand: required checks `ci-ok` and `pr-title`, `strict` on, squash title `PR_TITLE`, squash message `BLANK`.
- [x] #11 `CLAUDE.md` lists the prerequisites, Bun at exactly the `.bun-version` version and the global Backlog CLI installed with `bun add -g backlog.md@1.53.0`, and a pinned versions table: Bun (exact, 1.4.2 per 0004), zod (4.x minor), TypeScript, oxlint, oxfmt, react and ink, and `@anthropic-ai/sandbox-runtime` 0.0.79.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S01 (DIPO-15). Before cutover: built by hand-run agents.

Implemented on branch DIPO-16/bootstrap-bun-workspace-verify-required.
- Workspace: root package.json (workspaces packages/*, engines.bun >=1.4.2 matching .bun-version 1.4.2), seven packages (six from 0004 plus private testkit), each private 0.0.0 with an exports map of only ./src/index.ts, one index.ts and one test. contract depends only on zod 4.6.5.
- Typecheck: tsc -b over composite project references (emitDeclarationOnly into per-package .tsbuild/, gitignored); the root tsconfig.json also checks scripts/ and test/.
- Lint: .oxlintrc.json no-restricted-imports bans tui/client -> engine/daemon, cli -> engine, and @dipsaus-orchestrator/*/src deep imports in every package. test/lint-boundaries copies the config and fixtures into a temp dir under DIPO_TMP (fallback /tmp) and asserts each violation is an error; one fixture proves allowed cli imports pass.
- Format: oxfmt with printWidth 100; backlog/, docs/, Markdown and bun.lock are ignored.
- bunfig.toml: randomize = true, retry = 0.
- scripts/check-pr-title.ts reads PR_TITLE; scope deps allows chore/fix only, main allows chore only; subject length counted in characters.
- ci.yml: verify (DIPO_TEST_CI=1), dependency-review (PRs only, 0016 licence allow list, fail-on-severity high), ci-ok (needs all, if always(); dependency-review may be skipped only outside PRs). Actions pinned by SHA: checkout v7.0.1, setup-bun v2.2.0, cache v6.1.0, dependency-review-action v5.0.0.
- Deviations: status set to In Progress because this Backlog.md config has no In Review status. client/node entry not added: the story says only index.ts per package, and DIPO-25 AC#3 adds that second exports entry.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Bun 1.4.2 workspace with seven packages (contract, engine, daemon, client, tui, cli, private testkit), verify script (format:check, lint, typecheck, test), oxlint import boundaries with fixture tests, PR-title checker per 0016, CI (verify, dependency-review, ci-ok) and pr-title workflows with SHA-pinned actions, CLAUDE.md prerequisites and pinned versions. Reviewer pass; dependency graph enabled (Dependabot alerts on per 0016).
<!-- SECTION:FINAL_SUMMARY:END -->
