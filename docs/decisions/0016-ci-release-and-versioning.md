# 0016 CI, release and versioning

Status: accepted. First written 2026-10-10 (spike DIPO-13). Rewritten 2026-10-24 for the simplified design. The research behind the rewrite is in `docs/research/2026-10-24-simplification-audit.md`. How dipo merges its own story PRs is in 0002.

## Decision in short

One CI workflow checks every PR and every push to `main`, behind two required checks, `ci-ok` and `pr-title`. Versions come from Conventional Commit PR titles through release-please. A release is one `darwin-arm64` binary (0004). It is published only by the maintainer, through two gates, after a live smoke run.

## 1. CI (`.github/workflows/ci.yml`)

It runs on `pull_request` and on `push` to `main`, with `concurrency` per ref.

**Hardening.**
- Top-level `permissions: {}`, and each job gets only what it needs.
- Every action pinned by full commit SHA.
- `persist-credentials: false`, and never `pull_request_target`.
- Text from a PR reaches a shell only through environment variables.
- Bun comes from `.bun-version`, and the install is `bun install --frozen-lockfile`.

| Job | Runner | Does |
|---|---|---|
| `changes` | `ubuntu-24.04` | Decides whether the PR changes only `backlog/`; the heavy jobs below skip when it does |
| `ready-gate` | `ubuntu-24.04` | The Ready gate and the structural check of 0010 on every story the PR changes |
| `checks` | `ubuntu-24.04` | `bun run check`: format, lint and typecheck, once, since both OS give the same result |
| `test-shards` | `ubuntu-24.04` | The coverage check: every test file is in exactly one shard of `verify` and of `verify-macos` |
| `verify` | `ubuntu-24.04` | `bun test` with `DIPO_TEST_CI=1`, so with the CI-only tests, as a matrix of three parallel shards; `scripts/test-shards.ts` splits the files by the per-file times in `scripts/test-timings.json` |
| `verify-macos` | `macos-26` | The same in four shards, on macOS, where the box and the platform code are real |
| `shellcheck` | `ubuntu-24.04` | `install.sh` and other shell scripts |
| `actionlint` | `ubuntu-24.04` | The workflow files |
| `dependency-review` | `ubuntu-24.04` | PRs only: fails on new dependencies with high or critical advisories, or with a licence outside the allow list |
| `smoke (darwin-arm64)` | `macos-26` | `bun scripts/build.ts`, then `dipo --version`, `dipo --help`, a `file` check and `codesign -v` (an ad-hoc signature is added when missing) |
| `ci-ok` | `ubuntu-24.04` | Needs every job above; fails unless each succeeded or was skipped by design |

Runner labels are explicit, never `-latest`.

**Test shards.** Together `checks` and the shards run what `bun run verify` runs locally in one go. A failed or cancelled shard makes its matrix job failed or cancelled, so `ci-ok` fails. A test file with no recorded time goes to the shard with the least time. `bun scripts/test-timings.ts <run id>` refreshes the times from the logs of a green run.

**Backlog-only PRs take the light path.** When `changes` finds that a PR changes only `backlog/`, the `checks`, `test-shards`, `verify`, `verify-macos`, smoke, shellcheck, actionlint and dependency-review jobs skip by design, and only `ready-gate` and `pr-title` run. `ci-ok` stays required and passes on that path. Setting stories Ready, in bulk if needed, then takes minutes and changes no code.

**The PR title check** (`.github/workflows/pr-title.yml`, job `pr-title`) runs `scripts/check-pr-title.ts` on `opened`, `edited`, `synchronize` and `reopened`. It is the second required check. Accepted titles:

```
<type>(<scope>)[!]: <subject>
type    = feat | fix | perf | refactor | docs | test | build | ci | chore | revert
scope   = DIPO-<n>[.<m>]    story PRs
        | deps              Renovate only
        | main              release-please only
        | backlog           backlog PRs with no single story
subject = 1 to 100 characters, no trailing period
```

`!` is the only way to mark a breaking change. dipo builds the title from the story (0002).

**`bun audit`** runs in `audit.yml` on PRs that touch `bun.lock` and daily. It is not required. A failing scheduled run opens or updates one issue labelled `security`.

## 2. Repository settings

The maintainer applies these by hand (`docs/release.md`, `CLAUDE.md`). Agents and dipo change them only when the maintainer asks.

- On `main`: PR required, 0 approvals, linear history, `enforce_admins`.
- Required checks `ci-ok` and `pr-title`. **`strict` is off:** a PR is brought up to date only on a conflict (0002).
- Squash merge only, with commit title `PR_TITLE` and commit message `BLANK`, so the checked title alone decides the version.
- **"Allow auto-merge" on**, which dipo's merges use (0002).
- **The branch ruleset "release path review":** a PR that changes `.github/**`, `install.sh`, the release-please config or `renovate.json` needs the code owner's review (`.github/CODEOWNERS` names the maintainer). Repository admins may bypass, on pull requests only. dipo treats every CODEOWNERS path as hand-merge only and never bypasses (0002).
- Immutable releases on. Private vulnerability reporting on, with `SECURITY.md`. Secret scanning and push protection on.
- A tag ruleset on `v*`: no updates or deletions, and creation only by the release GitHub App.

## 3. Versioning: release-please

- **SemVer 0.x** with `bump-minor-pre-major`. `1.0.0` is the maintainer's call.
- **One version** for the product, in the root `package.json`. Workspace packages are private, and nothing goes to npm.
- **The token.** release-please runs with a GitHub App token (`dipo-release`: `contents: write`, `pull-requests: write`), so its release PR triggers the required checks. The App's key lives only in the `release-please` environment, never as a repository secret, so a workflow edited on a branch cannot read it.
- **The first release** is `v0.1.0`. Until then `release.yml` is a dry run on `workflow_dispatch` that writes nothing.

## 4. The release flow (`.github/workflows/release.yml`)

There are two environments, both limited to the branch `main`, with the administrator bypass off:
- `release-please` holds the App key and needs no reviewer;
- `release` needs the maintainer as reviewer.

On a push to `main`:

1. **release-please** updates the release PR. When that PR was just merged, it creates the tag and a draft release with the changelog.
2. **Build:** `scripts/build.ts` on `macos-26` at the tag's commit, with a Bun checked against a pinned SHA-256. The output is `dipo-darwin-arm64.tar.gz` (the binary, `LICENSE` and `README.md`), plus `install.sh`.
3. **Publish** (environment `release`, the maintainer approves): it writes `SHA256SUMS`, makes build provenance attestations for every file, uploads them to the draft and publishes it. Immutable releases then lock the tag and assets.
4. **Post-release check:** it runs the published `install.sh`, then `dipo --version`. A failure opens an issue, and the fix is a patch release.

Attestations count only when verified with the pinned command:

```sh
gh attestation verify <file> --repo dipsaus9/dipsaus-orchestrator \
  --signer-workflow dipsaus9/dipsaus-orchestrator/.github/workflows/release.yml \
  --source-ref refs/heads/main
```

**Who may publish.** Only the maintainer, who merges the release PR and approves the `release` environment. **The live smoke run comes before that merge:** the maintainer builds `dipo` from the release PR's head, does one live run, and confirms it on the release PR. Agents and dipo never merge a PR labelled `autorelease: pending` and never approve a deployment (`CLAUDE.md`).

## 5. Installing and `--version`

- **The install script.** `curl -fsSL …/releases/latest/download/install.sh | sh` checks that it runs on macOS arm64, downloads the archive and `SHA256SUMS`, verifies the checksum, verifies the attestation when `gh` is installed, and installs to `${DIPO_INSTALL_DIR:-$HOME/.local/bin}` without sudo. `DIPO_VERSION` pins a version. There is no self-update.
- **No notarization** before `1.0.0`: the binary is ad-hoc signed. `curl` sets no quarantine attribute, so Gatekeeper does not check it. A browser download needs `xattr -d com.apple.quarantine ./dipo`.
- **`dipo --version`** prints `dipo <version> (<commit> <commit date>) bun <version> darwin-arm64`. A dev build adds `-dev`, and `--json` prints the same fields.

## 6. Dependency updates and bot PRs

- **Renovate**, the Mend-hosted app, configured in `renovate.json`:
  - weekly, with semantic commits and `minimumReleaseAge: 3 days`;
  - groups for TypeScript tooling, Bun and GitHub Actions;
  - its vulnerability alerts on;
  - automerge only for devDependency minor and patch updates, outside the Bun group;
  - `backlog.md` stays on 1.53.x and never automerges (0010).

  Dependabot alerts stay on as a second signal.
- **CodeQL** default setup for `javascript-typescript` and `actions`. It is not a required check while TypeScript 7 is newer than its documented support.

| PR | Review | Merge |
|---|---|---|
| Renovate devDependency minor or patch | None beyond the required checks | Renovate automerge |
| Other Renovate PRs: GitHub Actions, runtime dependencies, majors, Bun, security fixes, lockfile maintenance | The reviewer agent, against a fixed contract: the update is what the title says, no breaking change touches our use, the checks pass, no unrelated files | After the review. A PR on the release path also waits for the maintainer (section 2) |
| The release-please PR | The reviewer agent checks the bump and changelog | Maintainer only |

## Replaced

- Four release targets: darwin-arm64, darwin-x64, linux-x64 and linux-arm64 (2026-10-10). Replaced by darwin-arm64 only (2026-10-24, 0004). The smoke jobs for the other three go, as do the glibc floor checks and the musl question.
- `strict` on, with a merge slot that kept branches up to date at merge time (2026-10-10). `strict` turned off (2026-10-22). The slot was replaced by GitHub auto-merge (0002, 2026-10-24).
- Fix rounds from a merge-time sync counted against the review round cap (2026-10-10). Replaced by one cap per source (0002).
- Lockfile maintenance automerge (2026-10-10). Turned off (2026-10-23).
- The full CI on every PR, backlog-only ones included (2026-10-10). Replaced by the light path for backlog-only PRs (2026-10-24).
- A Homebrew tap after the first stable minor. Moved to Later (0003).
- `setup-bun` with its cache in the release build (2026-10-10). Replaced by a Bun checked against a pinned SHA-256 (2026-10-23).
