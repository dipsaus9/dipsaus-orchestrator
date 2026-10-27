# dipsaus-orchestrator

Open source, code-driven orchestration product: the maintainer and a model run the maintainer's software products together, like an office or dev team, with AI filling the gaps code cannot. Read `docs/vision.md`, `docs/concepts.md`, `docs/decisions/` and `docs/research/` before making design choices. Ideas from other tools are inspiration only, never copied (0001).

## Status

M0 is done. M1 is paused since 2026-10-24 while the code is pruned toward the rewritten ADRs (`docs/research/2026-10-24-simplification-audit.md`). The ADRs describe that target; where the code still differs, the prune plan closes the gap. Stack (0004): TypeScript on Bun, single binary `dipo`, macOS on Apple silicon.

The repository is a Bun workspace (`packages/*`) with the packages `contract`, `engine`, `daemon`, `client`, `tui`, `cli` and the private test helpers `testkit`, all scoped `@dipsaus-orchestrator/*`. Import boundaries (0004) are oxlint rules in `.oxlintrc.json`, proven by `test/lint-boundaries/`.

One command checks everything, locally, in workers and in CI:

```sh
bun run verify   # oxfmt --check, oxlint --deny-warnings, tsc -b, bun test; stops at the first failure
```

`bun run format:fix` rewrites formatting. Tests that only run in CI are named `*.ci.test.ts` and register only when `DIPO_TEST_CI=1`; local `bun test` stays under about 60 seconds. Tests write temp files and sockets only under `DIPO_TMP` (fallback `/tmp`) (0017).

CI (0016): `.github/workflows/ci.yml` (jobs `verify` (Linux) and `verify-macos` (macOS, DIPO-316), both with `DIPO_TEST_CI=1`, `shellcheck`, `actionlint`, `dependency-review`, `smoke (*)` on four targets (darwin-arm64 only once the prune plan lands, 0016) through `.github/actions/smoke`, aggregate `ci-ok`) and `.github/workflows/pr-title.yml` (job `pr-title`, runs `scripts/check-pr-title.ts`).

Release (0016, `docs/release.md`): `.github/workflows/release.yml` is a dry run on `workflow_dispatch` until `v0.1.0`; release-please reads `release-please-config.json` and `.release-please-manifest.json`; `install.sh` installs a release.

Repository settings the maintainer applies by hand on `main` (0016):

- Required status checks: `ci-ok` and `pr-title` (app GitHub Actions).
- `strict` off (since 2026-10-22, 0016): a PR is brought up to date with `main` only on a conflict.
- Squash merge commit title `PR_TITLE`, squash merge commit message `BLANK`.
- Branch ruleset "release path review" (since 2026-10-23, 0016, DIPO-321): pull request required, 0 approvals, "Require review from Code Owners" (`.github/CODEOWNERS`: `.github/`, `install.sh`, the release-please config, `renovate.json`); bypass for repository admins, pull requests only. Agents and dipo never bypass it.

## Prerequisites

- Bun at exactly the version in `.bun-version` (1.4.2). `engines.bun` in `package.json` is the same floor.
- The Backlog CLI installed globally at the pinned version: `bun add -g backlog.md@1.53.0`.
- `git` and `gh`.

## Pinned versions

Dependencies are pinned exactly in `package.json`. Later stories add the packages below that are not installed yet, at these versions.

| Package | Version | Where |
|---|---|---|
| Bun | 1.4.2 (exact, `.bun-version`; 0004) | runtime, CI |
| `@types/bun` | 1.4.2 (follows Bun) | root devDependency |
| `zod` | 4.6 (4.x minor; pinned 4.6.5) | `contract` dependency |
| `typescript` | 7.0.2 | root devDependency |
| `oxlint` | 1.87.0 | root devDependency |
| `oxfmt` | 0.72.0 | root devDependency |
| `react` | 19.3.0 | `tui` (later story, 0009) |
| `ink` | 8.0.0 | `tui` (later story, 0009) |
| `@anthropic-ai/sandbox-runtime` | removed | removed by DIPO-343 (0004, 0008) |
| `backlog.md` | 1.53.0 (stays on 1.53.x) | global CLI; repository devDependency from DIPO-18 |
| `release-please` | 17.11.2 (CLI, dry run) and action v5.0.0 | `release.yml` only, never installed |

## Rules

- Code drives, AI fills the gaps. If the orchestrator already knows an answer from the backlog, git or its own state, it must not ask a model.
- Anything deterministic is code, never prose for a model to follow.
- Engine is headless. UIs are clients that send commands and read events. No UI imports engine internals.
- Backlog.md/CLI is the source of truth for stories. Never edit task files by hand when the CLI can do it.
- Local work state is per project, kept in one central local database keyed by office (0007), never in the repository, and never the only copy of a story fact.
- Claude is reached only through the worker adapter. Keep Claude specifics out of the engine.
- One mechanism per goal: a fix names the mechanism it replaces and removes it (0001, 0003).
- Decisions that change `docs/decisions/` need the user's explicit approval. Ask when unsure.
- ADRs describe what runs: a changed decision rewrites the ADR body and adds one line to its Replaced list, never an amendment log. Code and docs cite ADRs by number only, never by section (0003).

## Backlog

- Prefix `DIPO`. Milestones `m-0` to `m-5` are M0 to M5 (see `docs/decisions/0003-milestones-and-quality-bar.md`). Backlog.md has no epic type, so milestones play that role.
- Architecture spikes (`--type spike`) each end in an ADR in `docs/decisions/`. Implementation stories are written after the spikes resolve.
- `auto_commit` is off. Commit backlog changes yourself.
- A story that adds or replaces a guard, a deny rule, a sandbox setting or a permission check lists in its criteria: what the old barrier caught, with a test for each; the bypass forms to test (wrappers, quoting, indirection, chaining); and a fail-closed test against the real path rather than a fake. The Ready gate refuses such a story without them (R30).

## Review

- Every PR is reviewed by a separate agent against the story goal before merge. Fix its feedback, then merge. The maintainer tests behavior and does not review code. See `docs/decisions/0002-review-and-testing.md`.

## Releases

- Agents and the orchestrator never merge a PR labelled `autorelease: pending` and never approve a deployment (0016). Only the maintainer merges the release PR and approves the `release` environment.
- Each release waits for the maintainer's live smoke run: one live run of `dipo` built from the release PR's head, confirmed on the release PR before it merges (0016).
- Repository settings, the `release-please` and `release` environments, the `v*` tag ruleset and the release GitHub App are set up by the maintainer by hand (`docs/release.md`). Agents change them, or create tags and releases, only when the maintainer asks.

## Git

- Early bootstrap commits may go to `main`. After the initial backlog exists, work on `<ID>/<slug>` branches and merge by PR.
- Commits are small and scoped. Never `git add -A`. Never skip hooks.
- PR titles use Conventional Commits with the story as scope: `type(DIPO-n): title`, for example `feat(DIPO-21): stream worker events to the TUI` (0016).
