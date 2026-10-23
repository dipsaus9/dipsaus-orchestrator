# Releases

How `dipo` is released, from decision 0016 (rules 2, 3, 4, 7 and 12) and decision 0017 (live smoke run). The workflow is `.github/workflows/release.yml`; release-please reads `release-please-config.json` and `.release-please-manifest.json`.

## Current state: dry run

Until `v0.1.0`, `release.yml` is a dry run (0016 rule 3):

- It starts only by hand, with `workflow_dispatch` on `main`.
- release-please runs as the CLI with `--dry-run`. It reports the release PR it would open (title, version, changelog) and the release it would tag, and writes nothing.
- The build matrix builds and smoke-tests `dipo` on the four native runners and keeps `dipo-<os>-<arch>.tar.gz` as workflow artifacts.
- `publish` and `post-release` are skipped. No tag, release, upload or attestation is made.

The dry run cannot test the tag ruleset, immutable releases or the `release` environment. The first real release is the first time they run, so `v0.1.0` is cut with that in mind.

## One-time maintainer steps

These are repository and account settings. Agents never change them. Do them in this order, before the first dry run.

1. **GitHub App `dipo-release`** (owned by `dipsaus9`). GitHub > Settings > Developer settings > GitHub Apps > New GitHub App.
   - Homepage URL: the repository URL. Turn off Webhook.
   - Repository permissions: Contents **Read and write**, Pull requests **Read and write**, Metadata **Read-only** (set by default). Nothing else.
   - "Where can this GitHub App be installed?": Only on this account.
   - After creating it, note the **Client ID** and generate a **private key** (a `.pem` file).
   - Install the App on **only** `dipsaus9/dipsaus-orchestrator`, not on all repositories.
   - If release-please later fails to create the `autorelease: pending` label, add Issues **Read and write**; decision 0016 rule 3 then needs an amendment.
2. **Environment `release-please`**. Settings > Environments > New environment.
   - Deployment branches and tags: **Selected branches and tags**, add the branch rule `main` only (not "Protected branches only").
   - No required reviewers.
   - Turn **off** "Allow administrators to bypass configured protection rules".
   - Environment secrets: `RELEASE_APP_CLIENT_ID` (the App's Client ID) and `RELEASE_APP_PRIVATE_KEY` (the full contents of the `.pem` file). Delete the `.pem` file afterwards.
   - Never store these as repository or organisation secrets (0016 rule 3).
3. **Environment `release`**.
   - Deployment branches and tags: **Selected branches and tags**, branch `main` only.
   - Required reviewers: the maintainer (`dipsaus9`). Turn **off** "Allow administrators to bypass configured protection rules".
   - No secrets until the Homebrew tap exists (0016 rule 9).
4. **Tag ruleset on `v*`**. Settings > Rules > Rulesets > New tag ruleset.
   - Name `release tags`, enforcement **Active**, target tags matching `v*`.
   - Rules: **Restrict creations**, **Restrict updates**, **Restrict deletions**.
   - Bypass list: the `dipo-release` App only.
5. **Immutable releases**. Settings > General > Releases: turn on **Enable release immutability**.
6. **Private vulnerability reporting**. Settings > Security (Advanced Security) > turn on **Private vulnerability reporting**. `SECURITY.md` already sends reporters there (0016 rule 2). Skip this step if it is already on.
7. **Code owner review of the release path** (DIPO-321). `.github/CODEOWNERS` gives `.github/`, `install.sh`, `release-please-config.json`, `.release-please-manifest.json` and `renovate.json` to `@dipsaus9`. Settings > Rules > Rulesets > New branch ruleset.
   - Name `release path review`, enforcement **Active**, target the default branch.
   - Rule **Require a pull request before merging** with **Required approvals** 0 and **Require review from Code Owners** on. Nothing else in this ruleset; the branch protection on `main` stays as it is.
   - Bypass list: **Repository admin**, mode **For pull requests only**.
   - A PR from a bot or another account that touches those files then waits for the maintainer's approving review. GitHub does not count an author's review of their own PR, so a PR opened with the maintainer's own login (agents and dipo use it) merges only when the maintainer ticks "Merge without waiting for requirements to be met (bypass rules)". Agents and dipo never bypass.

The private key of the release App never belongs in the repository: `.gitignore` ignores `*.pem` and the other key, certificate, env and npm credential files.

Create both environments before the first run of `release.yml`. A workflow that names an environment that does not exist creates it without any protection rules.

## Manual test of the dry run

Run after this workflow is on `main` and steps 1 and 2 above are done (steps 3 to 6 are not needed for a dry run).

```sh
gh workflow run release.yml --ref main
gh run list --workflow release.yml --limit 1        # note the run id
gh run watch <run-id>
gh run view <run-id>                                # jobs and summary
gh run download <run-id> --dir /tmp/dipo-dry-run    # the four archives
ls /tmp/dipo-dry-run/*/
tar -tzf /tmp/dipo-dry-run/dipo-darwin-arm64/dipo-darwin-arm64.tar.gz
gh release list --repo dipsaus9/dipsaus-orchestrator
git ls-remote --tags origin
gh pr list --repo dipsaus9/dipsaus-orchestrator --label "autorelease: pending"
```

Expect:

- The run summary has a "release-please dry run" section with the proposed release PR title (`chore(main): release 0.1.0` while the manifest says `0.0.0` and `main` has `feat` commits) and the changelog in the collapsed `release-pr --dry-run` output.
- Jobs `release-please` and the four `build (*)` jobs are green; `publish` and `post-release` are skipped.
- Four artifacts, `dipo-darwin-arm64`, `dipo-darwin-x64`, `dipo-linux-x64` and `dipo-linux-arm64`, each holding `dipo-<os>-<arch>.tar.gz` with `dipo`, `LICENSE` and `README.md`.
- `gh release list` and `git ls-remote --tags` show no release and no tag, and no PR carries `autorelease: pending`.

## Switch to real releases (`v0.1.0`)

One change to `release.yml`, made with the maintainer's approval (0016 rule 3), once M0's walking skeleton has delivered one story end to end:

1. Set `DRY_RUN: "false"` in the workflow `env`.
2. Add `push: branches: [main]` under `on`, next to `workflow_dispatch`.

Steps 1 to 7 of the one-time list must be done first.

## Each release

1. Every push to `main` updates the release PR (`chore(main): release X.Y.Z`, label `autorelease: pending`).
2. A reviewer agent checks the version bump and changelog against the merged PRs (0016 rule 11).
3. **Live smoke run (0017 section 1).** The maintainer builds `dipo` from the release PR's head with `bun scripts/build.ts`, does one live run (a story taken end to end against real Claude) and confirms the result on the release PR. Without that confirmation the release PR is not merged. This run is never automated.
4. **Gate 1:** the maintainer merges the release PR. release-please tags `vX.Y.Z` and creates a draft release.
5. The four builds run at the tag. Each downloads the Bun of `.bun-version` from Bun's release, checks it against the SHA-256 pinned in `release.yml` and restores no cache. A Bun update changes `BUN_VERSION` and the four `bun-sha256` values in `release.yml` together with `.bun-version`, copied from that Bun release's `SHASUMS256.txt`; `scripts/release-path.test.ts` fails while they differ.
6. **Gate 2:** the maintainer approves the `publish` deployment in the `release` environment. `publish` writes `SHA256SUMS`, attests every archive, `SHA256SUMS` and `install.sh`, uploads them to the draft and publishes it.
7. `post-release` installs the published release with `install.sh` on macOS arm64 and Linux x64 and runs `dipo --version`. A failure opens an issue; immutable releases are fixed forward with a patch release.

Agents and the orchestrator never merge a PR labelled `autorelease: pending` and never approve a deployment (0016 rule 12).

If a draft release failed before publishing, rerun steps 5 and 6 with `gh workflow run release.yml --ref main -f tag=vX.Y.Z` (real releases only; the dry run refuses the input). Run it before anything else merges to `main`: an attestation names the commit the workflow ran on, and `install.sh` accepts only the commit the tag points at.

## Installing and verifying

`install.sh` (0016 rule 7) always checks the archive against `SHA256SUMS` from the same release. It also checks the build provenance attestation, and how depends on `gh`:

- **With `gh`** (logged in with `gh auth login`): the script asks GitHub for the release tag (the latest release unless `DIPO_VERSION` names one) and the commit that tag points at, downloads from that tag, and runs

  ```sh
  gh attestation verify dipo-<os>-<arch>.tar.gz --repo dipsaus9/dipsaus-orchestrator \
    --signer-workflow dipsaus9/dipsaus-orchestrator/.github/workflows/release.yml \
    --source-ref refs/heads/main --source-digest <commit of the tag>
  ```

  So the archive must have been built by `release.yml` running on `main` at the tagged commit. If `gh` cannot read the tag or its commit, or the attestation does not verify, nothing is installed.
- **Without `gh`**: the script stops before downloading anything and prints how to verify: install `gh` and run it again, or download the archive and `SHA256SUMS` yourself, compare the SHA-256 and run the command above.
- **Opt-out**: `DIPO_SKIP_ATTESTATION=1` installs without the attestation check, with or without `gh`. The SHA-256 checksum is still checked. Any other value is refused.

