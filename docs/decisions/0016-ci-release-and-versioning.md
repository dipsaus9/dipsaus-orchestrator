# 0016 CI, release and versioning

Status: Proposed (spike DIPO-13, 2026-10-10). All open questions were answered by the maintainer on 2026-10-10; awaiting acceptance.

## Context

Decision 0004 fixed the stack: TypeScript on Bun 1.4 (pinned exactly in CI), Bun workspaces, `bun run verify` (oxfmt check, oxlint, `tsc -b`, `bun test`), one binary `dipo` built with `bun build --compile` for darwin-arm64, darwin-x64, linux-x64 and linux-arm64. Binaries go to GitHub Releases first, a Homebrew tap later, no npm. macOS and Linux only. A compile smoke test runs in CI, not in `verify`.

Decision 0002: a reviewer agent reviews every PR against its story; the maintainer does not review code; merging, including auto-merge, is allowed after the review passes. The maintainer keeps authority over what ships.

Repository state on 2026-10-10 (`gh api`):

- Public, MIT, owned by the user `dipsaus9`, who is the only collaborator.
- Squash merge only (`squash_merge_commit_title: COMMIT_OR_PR_TITLE`), auto-merge allowed, branches deleted on merge.
- `main` protection: PR required, 0 approvals, linear history, `enforce_admins: true`, no required status checks, no rulesets.
- Secret scanning and push protection on. Dependabot security updates off. Private vulnerability reporting off.
- No workflows. PR titles so far look like `DIPO-1: Language, runtime and project structure (ADR 0004)`.

Facts checked for this ADR:

- `oven-sh/setup-bun` v2.2.0 (2026-03-14) installs an exact Bun from `bun-version` or `bun-version-file` (`.bun-version` supported) and caches the Bun executable, not the package cache [1]. Bun 1.4.3 was released 2026-10-10, 1.4.2 on 2026-09-05 [2].
- GitHub-hosted runners, free for public repos: `macos-26` / `macos-15` (arm64), `macos-26-intel` / `macos-15-intel` (x64), `ubuntu-24.04` (x64), `ubuntu-24.04-arm` (arm64, GA for public repos since August 2025) [3][4]. GitHub ends macOS x64 support when the macOS 15 image retires in fall 2027; macOS 26 is the last Intel macOS [5]. `ubuntu-latest` moves to 26.04 in November 2026 [3].
- `bun build --compile` targets: `bun-darwin-{arm64,x64}`, `bun-linux-{x64,arm64}` (glibc) and `bun-linux-{x64,arm64}-musl`. Cross-compiling works. `--define` inlines build-time constants. Signing uses `codesign`, with JIT entitlements under the hardened runtime [6]. A local test (Bun 1.3.5, macOS 26.6) produced an ad-hoc signed arm64 binary and `--define VERSION=...` worked.
- Bun publishes no minimum glibc for compiled binaries; its install docs point users with `GLIBC_2.29 not found` errors to the musl build [7].
- Notarizing needs an Apple Developer Program membership (99 USD a year), a Developer ID certificate, the hardened runtime and a secure timestamp [8][9]. A bare executable can be notarized but not stapled; Gatekeeper fetches the ticket online on first run [10]. Since macOS Sequoia, Control-click no longer bypasses Gatekeeper; users approve in System Settings > Privacy & Security [11].
- Only files with the `com.apple.quarantine` attribute are checked by Gatekeeper. Browsers set it; `curl` does not (verified locally on macOS 26.6).
- release-please: action v5.0.0 (2026-04-22, Node 24), core v17.11.2 (2026-08-24) [12]. Draft releases with `force-tag-creation` are supported [13]. Resources created with `GITHUB_TOKEN` do not trigger other workflows; a GitHub App token or PAT is needed for CI to run on the release PR [12][14].
- changesets is active (`changesets/action` v2.1.2, 2026-09-07) [15].
- Renovate has a Bun manager for `bun.lock` and a `bun-version` manager for `.bun-version` [16][17]. Dependabot supports Bun version updates but not Bun security updates [18]. GitHub's dependency graph lists no Bun lockfile, so only `package.json` is seen [19].
- `bun audit` checks `bun.lock` against the npm advisory database and exits 1 on findings [20].
- CodeQL is free for public repos; its documented TypeScript support ends at 5.9 [21]. This repo uses TypeScript 7.
- Immutable releases are GA: assets and tags are locked after publish; the docs recommend draft, upload, publish [22]. Artifact attestations are free for public repos (`actions/attest-build-provenance` v4.2.2) [23].
- Homebrew deprecated casks that fail Gatekeeper (cutoff 2026-09-01); formulas that download a prebuilt CLI are not casks [24].

## Options

### Versioning and changelog

- **A. release-please.** Reads Conventional Commits on `main`, keeps one release PR with the version bump and `CHANGELOG.md`, tags and creates the GitHub Release on merge. Fully derived from git.
- **B. changesets.** Each PR adds a `.changeset/*.md` file with a bump type and prose. Built for many npm packages with independent versions. We ship one binary and publish nothing to npm, so per-package versioning is unused and every PR carries an extra hand-written file.
- **C. Manual tags plus generated notes** (`gh release create --generate-notes` or git-cliff). Least setup, but the version number is chosen by hand each time.
- **D. semantic-release.** Releases on every qualifying merge. No release PR, so no single point where the maintainer decides to ship.

### Build trigger

- **A. Tag-push workflow** (`on: push: tags: v*`). Simple to reason about, but a tag created by release-please with `GITHUB_TOKEN` does not start it [14].
- **B. One release workflow on push to `main`.** release-please runs first; when it reports `release_created`, later jobs in the same run build, smoke-test, checksum and upload.

### Dependency updates

- **Renovate** (free Mend-hosted GitHub App). Updates `bun.lock`, `.bun-version`, action SHAs, with grouping, `minimumReleaseAge` and automerge rules. Its own vulnerability PRs cover Bun. Third-party app with write access.
- **Dependabot.** Native, no extra app, has `cooldown` and `groups`. Cannot open security PRs for Bun and cannot update `.bun-version`.

### macOS signing

- **Sign and notarize** each darwin binary inside a signed, notarized container (zip for notarization; the binary itself cannot be stapled). Costs 99 USD a year, an Apple account tied to the maintainer, and certificates and an app-specific password as CI secrets.
- **Ship ad-hoc signed, not notarized,** and avoid quarantine: the install script and Homebrew download with `curl`. Document the workaround for browser downloads.

### Linux libc

- **glibc only** (the four targets in 0004), **glibc plus musl** (six targets), or **musl only** (Bun's musl binaries link musl dynamically, so they do not run on glibc systems).

### Install path

- **Install script**, **manual download**, or both.

## Decision

### 1. CI workflow (`.github/workflows/ci.yml`)

Runs on `pull_request` and on `push` to `main`, so `main` itself is checked after every merge. `concurrency` per ref, cancel in progress for PRs. Top-level `permissions: {}`; each job asks only for what it needs (`contents: read` by default). Every action is pinned by full commit SHA; Renovate updates the SHAs. `actions/checkout` uses `persist-credentials: false`. No `pull_request_target`.

Bun setup in every job: `oven-sh/setup-bun` with `bun-version-file: .bun-version`. The repo gets a `.bun-version` file with one exact version (1.4.2 or newer when the first workflow lands), which is also the floor in `engines`. Dependencies: `actions/cache` on `~/.bun/install/cache`, key `bun-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('bun.lock') }}`, then `bun install --frozen-lockfile`. No cache for `tsc` build info; correctness over seconds.

Jobs:

| Job | Runner | Does |
|---|---|---|
| `verify` | `ubuntu-24.04` | `bun run verify`, exactly as run locally and by workers (0004 unchanged) |
| `shellcheck` | `ubuntu-24.04` | `shellcheck install.sh` and any other shell scripts. Separate job so CI `verify` stays identical to local `verify` |
| `dependency-review` | `ubuntu-24.04` | PRs only. `actions/dependency-review-action`, fails on new direct dependencies with high or critical advisories or a licence outside the allow list (MIT, ISC, BSD-2/3-Clause, Apache-2.0, 0BSD, CC0-1.0, BlueOak-1.0.0). Sees `package.json` only [19] |
| `smoke (darwin-arm64)` | `macos-26` | Build and smoke test, see below |
| `smoke (darwin-x64)` | `macos-26-intel` | Same |
| `smoke (linux-x64)` | `ubuntu-24.04` | Same |
| `smoke (linux-arm64)` | `ubuntu-24.04-arm` | Same |
| `ci-ok` | `ubuntu-24.04` | `needs` all jobs above, `if: always()`, fails unless every needed job succeeded or was skipped by design |

Runner labels are explicit, never `-latest`, so image moves are deliberate changes.

The smoke test runs one script, `bun scripts/build.ts --target <target>`, the same script the release uses. On the built binary it checks: `dipo --version` exits 0 and prints the expected version and commit; `dipo --help` exits 0; `file` reports the expected OS and architecture. On macOS it also runs `codesign -v dipo`: Bun's docs do not promise an ad-hoc signature on compiled output (a local test showed one), so `scripts/build.ts` runs `codesign --sign - --force dipo` when `codesign -v` fails, and the smoke test fails if the binary is still unsigned. On Linux it records the highest `GLIBC_` symbol version (`objdump -T`) in the job summary so the real glibc floor is known per release. All targets run natively. When GitHub retires macOS x64 runners (fall 2027), darwin-x64 is cross-compiled on `macos-26` and smoke-tested under Rosetta 2; if Rosetta is unavailable there, darwin-x64 becomes build-only and that is noted in the release notes.

**PR title check** (`.github/workflows/pr-title.yml`). Runs on `pull_request` with types `opened`, `edited`, `synchronize`, `reopened`, so a retitled PR is rechecked without rerunning the whole CI. One job, `pr-title`, runs `bun scripts/check-pr-title.ts` on the title passed through an environment variable (never interpolated into the shell). It is a second required check, because `ci-ok` cannot aggregate jobs from another workflow, and folding `edited` into `ci.yml` would either rerun four smoke builds per title edit or let a title-only run overwrite a red `ci-ok`. Accepted titles:

```
<type>(<scope>)[!]: <subject>
type    = feat | fix | perf | refactor | docs | test | build | ci | chore | revert
scope   = DIPO-<n>[.<m>]      story PRs (required for every human or agent PR)
        | deps                Renovate only, with type chore or fix
        | main                release-please only: "chore(main): release X.Y.Z"
        | backlog             backlog and plan PRs with no single story, e.g. "chore(backlog): plan M1 stories"
subject = 1 to 100 characters, no trailing period
```

`!` in the title is the only way to mark a breaking change; a `BREAKING CHANGE:` footer is not used (rule 2 keeps commit bodies out of `main`). GitHub's default revert title (`Revert "..."`) fails; the reverting PR is retitled `revert(DIPO-n): ...`.

`bun audit --audit-level=high` runs in a separate `audit.yml` on PRs that touch `bun.lock` and on a daily schedule. It is not required: a new advisory must not block unrelated PRs. A failing scheduled run opens or updates one issue labelled `security`.

**Workflow permissions.** Top level is always `permissions: {}`; jobs get only this:

| Workflow | Job | `GITHUB_TOKEN` permissions | Other credentials |
|---|---|---|---|
| `ci.yml` | `verify`, `shellcheck`, `dependency-review`, `smoke (*)` | `contents: read` | none |
| `ci.yml` | `ci-ok` | none | none |
| `pr-title.yml` | `pr-title` | `contents: read` | none |
| `audit.yml` | `audit` | `contents: read` | none |
| `audit.yml` | `report` (scheduled runs only) | `issues: write` | none |
| `release.yml` | `release-please` | none | App token, environment `release-please` |
| `release.yml` | `build (*)` | `contents: read` | none |
| `release.yml` | `publish` | `contents: write`, `id-token: write`, `attestations: write` | environment `release` (no App key until the tap exists) |
| `release.yml` | `post-release` | `contents: read`, `issues: write` | none |

### 2. Required checks and branch protection

`main` keeps: PR required, 0 approvals, linear history, `enforce_admins: true`. Added:

- Required status checks: **`ci-ok`** and **`pr-title`**, app GitHub Actions. One aggregate check for `ci.yml` means adding or renaming jobs there never touches branch protection.
- **`strict` on** for the required checks (require branches to be up to date before merging): a PR must contain the latest `main` before it merges, so `ci-ok` always ran on what `main` becomes. No merge queue; the repository stays under the personal account. `ci` also runs on every push to `main`, and a red `main` is fixed before anything else merges.
- **Merging under `strict` (amends 0010's Base sync row).** While the worker builds, nothing changes: the branch syncs with the base only on a conflict or for a riskier story (0010). At merge time the **engine** always brings the branch up to date: it merges `origin/<base>` into the branch (never a rebase, never a force push), pushes, waits for the required checks, and merges when they are green. A merge conflict goes to the worker as feedback like any other conflict (within caps, else park `conflict`); red CI returns the story for a fix round. Merges run one at a time per office through the engine's git queue (0010), so a merge cannot make the next branch stale between its update and its merge. Until cutover, the agent that merges a PR in this repository follows the same steps. Bot PRs keep themselves current: Renovate's default `rebaseWhen: auto` rebases its own branches when the base requires up-to-date branches, and release-please rewrites its release PR on every push to `main`.
- Squash commit title set to `PR_TITLE`, so the checked PR title is always the commit subject on `main`. Squash commit message set to `BLANK`, so stray `BREAKING CHANGE:` or `Release-As:` lines in branch commits cannot change the version; the title alone decides.
- Immutable releases on. Private vulnerability reporting on, with a `SECURITY.md`.
- A tag ruleset on `v*`: no updates or deletions; creation only by the release GitHub App (bypass list).

These are repo-setting changes, applied by the maintainer or by the implementation story with the maintainer's approval. This ADR changes none of them.

### 3. Versioning and changelog: release-please (option A)

- Semantic Versioning, 0.x. Until `1.0.0`, `bump-minor-pre-major: true`: breaking changes and features bump minor, fixes bump patch. `1.0.0` is the maintainer's call, not a commit type.
- **First release `v0.1.0`** when M0's walking skeleton delivers one story end to end. Until then release-please and the build run as **dry runs**: release-please runs with the CLI's `--dry-run` (it reports the version and changelog it would propose and writes nothing), and the build matrix runs on `main` and keeps its archives as workflow artifacts; no tag, release or upload is made. This proves the pipeline before anything ships. The switch to real releases is one change to `release.yml`, made with the maintainer's approval.
- One version for the whole product, stored in the root `package.json` (`release-type: node`, manifest config at the root only). Workspace packages are `private` and stay at `0.0.0`; nothing is published to npm.
- PR titles follow the grammar in rule 1, e.g. `feat(DIPO-21): stream worker events to the TUI`. This replaces the current `DIPO-1: Title` style (open question 8). The engine derives the type from the story's type (0012 F5), in code, never by asking a model: `feature` and `enhancement` to `feat`, `bug` to `fix`, `docs` and `spike` to `docs`, `task` and `chore` to `chore`. The engine adds `!` only from an explicit story fact, never from a model's reading of the diff; until `1.0.0` a breaking change bumps minor like a feature anyway. The changelog shows `feat`, `fix`, `perf` and breaking changes; the scope makes each line traceable to its story.
- release-please needs a token other than `GITHUB_TOKEN` so the release PR triggers `ci` and `pr-title` and can pass the required checks [14]. The release-please README documents a PAT for this [12]; using a GitHub App installation token (`actions/create-github-app-token` [25]) instead is our choice, also allowed by GitHub's docs [14]. A fine-grained PAT was rejected: it expires, is tied to the maintainer's account and reaches every repo it is granted.

**The release GitHub App** (`dipo-release`, owned by `dipsaus9`):

- Repository permissions: `contents: write` (tags, release-please branch, draft release), `pull-requests: write` (release PR and its labels), `metadata: read` (implicit). Nothing else; if label creation fails during implementation, `issues: write` is added and this ADR is amended.
- Installed only on `dipsaus9/dipsaus-orchestrator`, and later on `dipsaus9/homebrew-tap`. Not on all repositories.
- It is the only actor on the `v*` tag ruleset's bypass list.
- Its App ID and private key are **never repository or organisation secrets**. Repository secrets reach `pull_request` workflows from same-repo branches, and agents push branches here, so a workflow edited on a branch could read the key and create tags past the ruleset. The key lives only in environment secrets (rule 4).

changesets was rejected because it adds a hand-written file to every PR for per-package versions we do not use; release-please derives everything from data git already has, which matches "code drives".

### 4. Release flow (`.github/workflows/release.yml`, trigger option B)

Two GitHub environments, both with deployment branch policy **"Selected branches and tags" with only the branch `main`** (not "Protected branches only"), and **"Allow administrators to bypass configured protection rules" turned off**, so no job running on a PR or another branch can enter them, even if a branch edits the workflow, and the maintainer's admin login (which agents also use) cannot skip the reviewer:

- **`release-please`**: no required reviewer, so every merge to `main` updates the release PR without waiting. Holds the App ID and private key as environment secrets. Used only by the `release-please` job.
- **`release`**: required reviewer is the maintainer. Used only by the `publish` job, which works with `GITHUB_TOKEN` (`contents: write`) and holds no App key. When the Homebrew tap arrives, the App key is added here too, because pushing to the tap needs it.

On push to `main` (and `workflow_dispatch` on `main`):

1. **release-please** (environment `release-please`, App token) updates the release PR, or, when a release PR was just merged, creates tag `vX.Y.Z` (`force-tag-creation: true`) and a **draft** GitHub Release with the changelog section.
2. If `release_created`: **build** matrix on the four native runners at the tag's commit, same `scripts/build.ts` and smoke test as CI. Each produces `dipo-<os>-<arch>.tar.gz` containing `dipo`, `LICENSE` and `README.md`. Asset names carry no version, so `releases/latest/download/<name>` is a stable URL.
3. **publish** job (environment `release`, maintainer approval, `GITHUB_TOKEN` only): downloads the artifacts, writes `SHA256SUMS`, creates build provenance attestations (`actions/attest-build-provenance`) for every archive, for `SHA256SUMS` and for `install.sh`, uploads all of them to the draft, then publishes it. Uploading to and publishing a draft does not create a tag, so the ruleset bypass is not needed here. Immutable releases lock tag and assets from that moment.
4. **post-release check** on macOS arm64 and Linux x64: runs the published `install.sh` from the release, then `dipo --version`. A failure opens an issue; immutable releases are fixed forward with a patch release.

**Limit of the environment gate.** The `release` environment gates the intended path only. A `pull_request` workflow from a same-repo branch can request its own `GITHUB_TOKEN` with `contents: write`, `id-token: write` and `attestations: write`, so a workflow edited on an agent branch could change a pending draft release or mint attestations for files it built. The backstop is pinned attestation verification: `install.sh`, the README and every consumer verify with

```sh
gh attestation verify <file> --repo dipsaus9/dipsaus-orchestrator \
  --signer-workflow dipsaus9/dipsaus-orchestrator/.github/workflows/release.yml \
  --source-ref refs/heads/main
```

which accepts only attestations signed by `release.yml` running on `main`. Rule 11 lists what the reviewer agent looks at in a workflow change.

A `workflow_dispatch` input `tag` reruns steps 2 and 3 for a draft that failed before publishing. Option A (tag-push trigger) was rejected because tags created with `GITHUB_TOKEN` do not start workflows, and with an App token it still splits one release over two runs.

### 5. `dipo --version`

`scripts/build.ts` passes `--define` constants: `DIPO_VERSION` (root `package.json`), `DIPO_COMMIT` (`git rev-parse --short=12 HEAD`, plus `-dirty` for a dirty tree), `DIPO_COMMIT_DATE` (commit date, not build time, so builds stay reproducible). Output:

```
dipo 0.3.0 (3f2a9c1e7b20 2026-11-02) bun 1.4.3 darwin-arm64
```

`dipo --version --json` prints the same fields as JSON for scripts. Local and CI builds outside a release print the `package.json` version with `-dev` appended. Running from source without the defines prints `dev (unknown commit)`.

### 6. macOS: no notarization for now; documented Gatekeeper workaround

Darwin binaries ship ad-hoc signed, which Apple silicon requires to run. `bun build --compile` produced one in a local test, but Bun does not document it, so the build script signs ad hoc when needed and the smoke test checks it (rule 1). No Developer ID, no notarization. Both supported install paths download with `curl`, which sets no quarantine attribute, so Gatekeeper does not check the file. For a browser download, the README documents one command:

```sh
xattr -d com.apple.quarantine ./dipo
```

or approving it once under System Settings > Privacy & Security. The maintainer accepted this until `1.0.0` (open question 1). Notarization is revisited before `1.0.0` or when the maintainer chooses to pay for the Apple Developer Program. If adopted: sign with `--options runtime --timestamp` and Bun's JIT entitlements, notarize a zip with `notarytool submit --wait` in the publish job, secrets in the `release` environment. No stapling is possible for a bare binary.

### 7. Install path: script plus manual

- **Script.** `install.sh` (POSIX `sh`, checked by the `shellcheck` CI job) is attached and attested on every release:
  `curl -fsSL https://github.com/dipsaus9/dipsaus-orchestrator/releases/latest/download/install.sh | sh`
  Users who want to check the script first download it, run the pinned `gh attestation verify install.sh ...` command from rule 4 (with `--signer-workflow` and `--source-ref`), then `sh install.sh`. The README shows both forms and only the pinned command.
  It detects OS and architecture from `uname`, refuses Windows and musl systems with a clear message, downloads the archive and `SHA256SUMS` from the same release, verifies the checksum (`sha256sum` or `shasum -a 256`) and stops on mismatch, and installs to `${DIPO_INSTALL_DIR:-$HOME/.local/bin}` without sudo, printing a PATH hint if needed. `DIPO_VERSION=v0.3.0` pins a version. If `gh` is installed it also runs the pinned `gh attestation verify` from rule 4 on the archive and stops on failure; otherwise it prints that command.
- **Manual.** The README lists the asset names, checksum and attestation commands, and the Gatekeeper note.
- No self-update in `dipo`; rerunning the script upgrades.

### 8. Linux: glibc only

The four targets from 0004 are glibc builds. Most developer machines and CI images are glibc. musl targets (Alpine) double the Linux matrix for users we do not have yet; they are added as two extra assets if someone asks, since Bun supports them. The glibc floor is whatever Bun's embedded runtime needs; the smoke test records it and the README states it.

### 9. Homebrew tap, later

When the maintainer asks for it (not before the first stable minor): repository `dipsaus9/homebrew-tap` with `Formula/dipo.rb`, a formula (not a cask) that downloads the prebuilt archive per OS and architecture and checks its sha256. Formulas download with `curl`, so the unnotarized binary works. The publish job then also commits the new version and checksums to the tap with the same App (installed on the tap repo, `contents: write` there), its key added to the `release` environment at that point. Users run `brew install dipsaus9/tap/dipo`.

### 10. Dependency updates and security scanning

- **Renovate** via the Mend-hosted app, config in `renovate.json`: `config:recommended`, `helpers:pinGitHubActionDigests`, semantic commits (`chore(deps): ...`), weekly schedule, `minimumReleaseAge: 3 days` (supply chain), groups for TypeScript tooling (oxlint, oxfmt, typescript), Bun (`.bun-version`, `@types/bun`) and GitHub Actions, `vulnerabilityAlerts` and `osvVulnerabilityAlerts` on, lockfile maintenance monthly. Dependabot was rejected because it cannot raise Bun security PRs or update `.bun-version`. Dependabot security updates stay off; Dependabot alerts stay on as a free second signal.
- **CodeQL** default setup (no workflow file) for `javascript-typescript` and `actions`, on PRs and weekly. Not a required check at first: TypeScript 7 is newer than CodeQL's documented support [21]. Alerts are triaged as stories. If extraction fails on TypeScript 7 code, CodeQL for `javascript-typescript` is paused and noted here; `actions` scanning stays.
- **Dependency review** and **`bun audit`** as in rule 1. Secret scanning and push protection stay on.

### 11. Bot PRs under decision 0002

Bot PRs have no story, so the reviewer agent reviews them against a fixed contract instead: the update is what its title says, release notes and changelog between the versions show no breaking change that touches our usage (or the PR adapts to it), `verify` and the smoke test pass, no unrelated files change.

**Workflow and release config PRs** follow the normal flow (open question 9): a PR, bot or story, that touches `.github/workflows/**`, `.github/actions/**`, `release-please-config.json` or `.release-please-manifest.json` is not test-before-merge; it merges after the reviewer agent passes, and auto-merge is allowed. The reviewer looks in particular at these points, as advisory findings unless they break an acceptance criterion: top-level `permissions: {}` and per-job permissions as in the table in rule 1; actions pinned by full SHA; no `pull_request_target`; `persist-credentials: false`; PR-controlled text reaches the shell only through environment variables; the `release-please` and `release` environments are used only by the jobs listed; required check names (`ci-ok`, `pr-title`) unchanged.

| PR | Review | Merge |
|---|---|---|
| Renovate: devDependency minor and patch; lockfile maintenance | None beyond `ci-ok` and `pr-title` (maintainer, 2026-10-10; amends 0002) | Renovate automerge (GitHub auto-merge) when the required checks pass |
| Renovate: every GitHub Actions update (digest, minor, major); runtime `dependencies` (compiled into `dipo`); any major; Bun version; security fixes | Reviewer agent with the contract above | Merge after the reviewer passes, auto-merge allowed |
| release-please release PR | Reviewer agent checks version bump and changelog against merged PRs | **Maintainer only.** Never auto-merged |

The first row is an explicit, narrow exception to "every PR is reviewed by a bot" in 0002. These updates do not ship inside `dipo`, but they do change what CI checks and how it builds (TypeScript, oxlint, oxfmt, test helpers), so the risk is real. It is limited by: `minimumReleaseAge: 3 days`, so a compromised or broken release is usually pulled before Renovate proposes it; the required checks; and, if oxlint supports it, an import rule that `packages/*/src` may not import devDependencies, so a devDependency cannot slip into the binary. Actions are excluded from automerge because they run with the workflow's permissions, and the release workflow's actions handle tokens and assets. Until cutover the maintainer starts reviewer runs for bot PRs as for stories; after cutover the orchestrator does.

### 12. Who may publish a release

Only the maintainer, through both gates: merging the release PR, and approving the publish job in the `release` environment. Both gates are revisited after the first few releases; removing the environment approval is a settings change only. Agents, the orchestrator and bots never merge a PR labelled `autorelease: pending` and never approve a deployment; the implementation story adds this rule to `CLAUDE.md`, and the orchestrator's merge code enforces it later. GitHub cannot tell an agent using the maintainer's `gh` login from the maintainer, so this is a rule plus friction, not a hard wall. The tag ruleset, immutable releases and attestations make an unauthorised or altered release visible and unchangeable rather than silent. Attestations count only when verified with the pinned command from rule 4 (`--signer-workflow .../release.yml`, `--source-ref refs/heads/main`); an attestation minted by a branch workflow fails that check.

## Consequences

- Every PR waits for two required checks: `pr-title` (seconds) and `ci-ok`, roughly the slowest of `verify` and four smoke builds. macOS runners are free on public repos; on a private fork they would cost minutes.
- PR titles change from `DIPO-1: Title` to `feat(DIPO-1): title`. Agents and the `dipsaus-ai` delivery skill used to build this repository must produce this format; the `pr-title` check enforces it. Changing the skill is a follow-up outside this repository.
- With `strict` on, every PR is brought up to date with `main` and CI runs again before it merges, and merges are serial per office. Parallel stories wait for each other at merge time instead of risking a red `main`.
- Until M0's walking skeleton delivers a story, the release pipeline runs dry and ships nothing.
- A GitHub App, two environments (`release-please`, `release`), a tag ruleset, Renovate and repo-setting changes must be set up once. The App key exists only as an environment secret limited to `main`. The implementation story lists them as steps for the maintainer.
- Unnotarized macOS binaries: browser downloads need one extra command. Recorded as accepted debt until notarization is revisited.
- No musl build: Alpine users cannot run `dipo` until musl assets are added.
- darwin-x64 loses native CI in fall 2027.
- CodeQL coverage of TypeScript 7 is unproven.
- Renovate is a third-party app with write access; its PRs pass the same `ci-ok` and title rules as ours.
- Releases are traceable: each changelog line names a story id, each asset has a checksum and provenance attestation, each tag is immutable.

## Open questions for the maintainer

1. **Notarization — answered 2026-10-10: no.** macOS binaries ship unnotarized, with the `curl`-based install and the documented workaround, until `1.0.0` (rule 6).
2. **First release — answered 2026-10-10: `v0.1.0` when M0's walking skeleton delivers one story end to end.** Until then release-please and the build run as dry runs that publish nothing; versions are SemVer 0.x with `bump-minor-pre-major`, and `1.0.0` is the maintainer's call (rule 3).
3. **Automerge exception — answered 2026-10-10: accepted.** devDependency minor/patch and lockfile-maintenance PRs merge on green required checks without the reviewer agent; Actions updates, runtime dependencies, majors, the Bun version and security fixes always get the reviewer (rule 11, amendment in 0002).
4. **Renovate or Dependabot — answered 2026-10-10: Renovate (Mend-hosted app), as drafted.** Dependabot security updates stay off (rule 10).
5. **Up-to-date branches — answered 2026-10-10: `strict` on, no merge queue.** The repository stays under the personal account; at merge time the engine merges the base into the branch, waits for green CI and merges, one at a time per office (rule 2, amendment in 0010).
6. **Release approval — answered 2026-10-10: both gates.** Merge of the release PR and approval of the `release` environment; revisit after the first few releases, since removing the environment approval is a settings change only (rule 12).
7. **musl and Homebrew timing — answered 2026-10-10: glibc-only Linux builds for now; Homebrew tap after the first stable minor.** As in rules 8 and 9.
8. **PR title format — answered 2026-10-10: Conventional Commits `type(DIPO-n): title`, enforced by `pr-title`.** The engine derives the type from the story type in code (rule 3); `CLAUDE.md` states the format, and the `dipsaus-ai` delivery skill used to build this repository must produce it (follow-up outside this repository).
9. **Workflow PRs — answered 2026-10-10: not test-before-merge.** PRs touching `.github/workflows/**`, `.github/actions/**` or release-please config follow the normal flow: reviewer agent pass, then auto-merge allowed; the reviewer's attention points in rule 11 are advisory.

## Sources

1. oven-sh/setup-bun README and v2.2.0 release. https://github.com/oven-sh/setup-bun
2. Bun releases (bun-v1.4.3, 2026-10-10; bun-v1.4.2, 2026-09-05). https://github.com/oven-sh/bun/releases
3. actions/runner-images README (available images and labels) and announcement #14748 (`ubuntu-latest` to 26.04). https://github.com/actions/runner-images
4. GitHub changelog, "arm64 hosted runners for public repositories are now generally available", 2025-08-07. https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/
5. GitHub changelog, "macOS 13 runner image is closing down" (x64 ends with macOS 15 image, fall 2027), 2025-09-19; "macOS 26 is now generally available", 2026-02-26. https://github.blog/changelog/2025-09-19-github-actions-macos-13-runner-image-is-closing-down/ , https://github.blog/changelog/2026-02-26-macos-26-is-now-generally-available-for-github-hosted-runners/
6. Bun docs, Single-file executables (targets, `--define`, codesign, entitlements). https://bun.com/docs/bundler/executables
7. Bun docs, Installation (glibc errors, musl build). https://bun.com/docs/installation
8. Apple, Apple Developer Program (membership fee). https://developer.apple.com/programs/
9. Apple, Notarizing macOS software before distribution. https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
10. Apple Developer Forums, "Signing/notarizing command line tools not built using Xcode" and "Notarization of a command line tool fails". https://developer.apple.com/forums/thread/130379 , https://developer.apple.com/forums/thread/725942
11. The Hacker News, "Apple's new macOS Sequoia tightens Gatekeeper controls", 2024-08. https://thehackernews.com/2024/08/apples-new-macos-sequoia-tightens.html
12. googleapis/release-please-action README and v5.0.0 release; googleapis/release-please v17.11.2. https://github.com/googleapis/release-please-action , https://github.com/googleapis/release-please/releases
13. release-please docs, manifest releaser (`draft`, `force-tag-creation`). https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md
14. GitHub docs, Triggering a workflow (GITHUB_TOKEN does not create workflow runs). https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow
15. changesets/action releases (v2.1.2, 2026-09-07). https://github.com/changesets/action/releases
16. Renovate docs, Bun manager. https://docs.renovatebot.com/modules/manager/bun/
17. Renovate docs, Bun Version manager. https://docs.renovatebot.com/modules/manager/bun-version/
18. GitHub docs, Dependabot supported ecosystems (Bun: version updates yes, security updates no). https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories
19. GitHub docs, Dependency graph supported package ecosystems (no Bun lockfile). https://docs.github.com/en/code-security/reference/supply-chain-security/dependency-graph-supported-package-ecosystems
20. Bun docs, `bun audit`. https://bun.com/docs/pm/cli/audit
21. CodeQL, Supported languages and frameworks (TypeScript up to 5.9). https://codeql.github.com/docs/codeql-overview/supported-languages-and-frameworks/
22. GitHub docs, Immutable releases; changelog "Immutable releases are now generally available", 2025-10-28. https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases
23. actions/attest-build-provenance (v4.2.2). https://github.com/actions/attest-build-provenance
24. Homebrew Gatekeeper cask deprecation, as reported in hluk/CopyQ issue #3498 (cask disabled 2026-09-01). https://github.com/hluk/CopyQ/issues/3498
25. actions/create-github-app-token (installation token for a GitHub App in workflows). https://github.com/actions/create-github-app-token
