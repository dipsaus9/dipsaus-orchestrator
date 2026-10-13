# dipsaus-orchestrator

A code-driven orchestration product where you and an AI model run your software projects together, like an office or development team: plan, refine, hire agents for roles, run work, review and test. Code drives, AI fills the gaps.

Status: pre-code, design phase. Start with [docs/vision.md](docs/vision.md) and [docs/plan.md](docs/plan.md), then [docs/concepts.md](docs/concepts.md) and [docs/decisions](docs/decisions).

License: MIT.

## Install

dipo runs on macOS (arm64, x64) and Linux (x64, arm64, glibc only). Windows and musl-based Linux such as Alpine are not supported. There is no release yet: the first is `v0.1.0`, and until then the release workflow is a dry run ([docs/release.md](docs/release.md)).

### Install script

```sh
curl -fsSL https://github.com/dipsaus9/dipsaus-orchestrator/releases/latest/download/install.sh | sh
```

To check the script before running it, download it, verify its attestation, then run it:

```sh
curl -fsSLO https://github.com/dipsaus9/dipsaus-orchestrator/releases/latest/download/install.sh
gh attestation verify install.sh --repo dipsaus9/dipsaus-orchestrator \
  --signer-workflow dipsaus9/dipsaus-orchestrator/.github/workflows/release.yml \
  --source-ref refs/heads/main
sh install.sh
```

The script picks the archive for your OS and architecture, downloads it with `SHA256SUMS` from the same release, stops on a checksum mismatch, and, when `gh` is installed, verifies the archive's attestation with the command above and stops on failure. It installs `dipo` to `$HOME/.local/bin` without sudo, by writing a temporary file next to it and renaming it over the old binary, so a running daemon keeps working until `dipo daemon restart`. Rerun it to upgrade.

- `DIPO_VERSION=v0.3.0` installs that release instead of the latest.
- `DIPO_INSTALL_DIR=/some/dir` installs there instead of `$HOME/.local/bin`.

### Manual download

Each release has these assets. Their names carry no version, so `https://github.com/dipsaus9/dipsaus-orchestrator/releases/latest/download/<asset>` always points at the latest release.

| Asset | Contents |
|---|---|
| `dipo-darwin-arm64.tar.gz` | macOS, Apple silicon |
| `dipo-darwin-x64.tar.gz` | macOS, Intel |
| `dipo-linux-x64.tar.gz` | Linux x64, glibc |
| `dipo-linux-arm64.tar.gz` | Linux arm64, glibc |
| `SHA256SUMS` | SHA-256 checksums of the four archives |
| `install.sh` | the install script |

Each archive holds `dipo`, `LICENSE` and `README.md`. The lowest glibc version a Linux build needs is recorded in the release build's job summary (highest `GLIBC_` symbol version).

```sh
asset=dipo-darwin-arm64.tar.gz
curl -fsSLO "https://github.com/dipsaus9/dipsaus-orchestrator/releases/latest/download/$asset"
curl -fsSLO https://github.com/dipsaus9/dipsaus-orchestrator/releases/latest/download/SHA256SUMS
grep " $asset\$" SHA256SUMS | shasum -a 256 -c -      # or: sha256sum -c --ignore-missing SHA256SUMS
gh attestation verify "$asset" --repo dipsaus9/dipsaus-orchestrator \
  --signer-workflow dipsaus9/dipsaus-orchestrator/.github/workflows/release.yml \
  --source-ref refs/heads/main
tar -xzf "$asset" dipo
mkdir -p ~/.local/bin && mv dipo ~/.local/bin/
```

Only trust an attestation checked with exactly these `--signer-workflow` and `--source-ref` flags: they accept only attestations made by `release.yml` running on `main`.

### macOS Gatekeeper

The macOS builds are ad-hoc signed, not notarized. `curl` (the install script and the commands above) sets no quarantine attribute, so Gatekeeper does not check the file. If you downloaded an archive with a browser, macOS blocks `dipo` on first run. Remove the quarantine attribute:

```sh
xattr -d com.apple.quarantine ./dipo
```

or allow it once under System Settings > Privacy & Security.
