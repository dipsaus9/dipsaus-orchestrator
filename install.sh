#!/bin/sh
# Installs dipo from a GitHub Release (0016) on macOS on Apple silicon (0004).
#
#   curl -fsSL https://github.com/dipsaus9/dipsaus-orchestrator/releases/latest/download/install.sh | sh
#
# Environment:
#   DIPO_VERSION           release tag to install, for example v0.3.0 (default: the latest release)
#   DIPO_INSTALL_DIR       directory for the binary (default: $HOME/.local/bin); no sudo is used
#   DIPO_SKIP_ATTESTATION  set to 1 to install without checking the build provenance attestation;
#                          the SHA-256 checksum is always checked
#
# Steps: check that this is macOS on Apple silicon; with gh, resolve the release tag and the commit
# it points at; download dipo-darwin-arm64.tar.gz and SHA256SUMS from that release; verify the
# checksum; verify the build provenance attestation with the pinned `gh attestation verify`,
# including the tag's commit as the source digest; then install. Without gh the script stops
# before downloading anything, unless DIPO_SKIP_ATTESTATION=1 (DIPO-321). The binary is written to
# a temporary file in the install directory and renamed over any existing dipo, so a running daemon
# keeps its open file and no half-written binary is ever on the PATH (0006).
#
# Everything runs inside main, called on the last line, so a partly downloaded script does nothing.

set -eu

REPO="dipsaus9/dipsaus-orchestrator"
SIGNER_WORKFLOW="$REPO/.github/workflows/release.yml"
SOURCE_REF="refs/heads/main"

say() {
  printf 'dipo install: %s\n' "$*"
}

fail() {
  printf 'dipo install: error: %s\n' "$*" >&2
  exit 1
}

# Fails unless this is macOS on Apple silicon, the only platform dipo runs on (0004).
check_platform() {
  kernel=$(uname -s)
  machine=$(uname -m)
  # An x86_64 shell under Rosetta 2 on Apple silicon still runs on Apple silicon.
  if [ "$kernel" = Darwin ] && [ "$machine" = x86_64 ] &&
    [ "$(sysctl -n sysctl.proc_translated 2> /dev/null || true)" = 1 ]; then
    machine=arm64
  fi
  if [ "$kernel" != Darwin ] || [ "$machine" != arm64 ]; then
    fail "dipo runs only on macOS on Apple silicon (darwin-arm64), and this is $kernel $machine. There is no dipo build for other platforms; nothing was downloaded or installed."
  fi
}

sha256_of() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum > /dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail "neither sha256sum nor shasum is installed, so the download cannot be checked."
  fi
}

attestation_command() {
  echo "gh attestation verify $1 --repo $REPO --signer-workflow $SIGNER_WORKFLOW --source-ref $SOURCE_REF"
}

# Fails unless $1 is a release tag such as v0.3.0.
check_tag() {
  case "$1" in
    v[0-9]*) ;;
    *) fail "$2 must be a release tag such as v0.3.0, got: $1" ;;
  esac
  case "$1" in
    *[!A-Za-z0-9.+-]*) fail "$2 must be a release tag such as v0.3.0, got: $1" ;;
  esac
}

# Without gh the attestation cannot be checked, so nothing is downloaded or installed.
fail_without_gh() {
  {
    printf 'dipo install: error: gh is not installed, so the build provenance attestation of %s cannot be checked. Nothing was downloaded or installed.\n' "$1"
    printf 'dipo install: To verify it here, install gh (https://cli.github.com), run gh auth login and run this script again.\n'
    printf 'dipo install: To verify it yourself, download %s and SHA256SUMS from %s, compare the SHA-256 and run:\n' "$1" "$2"
    printf 'dipo install:   %s --source-digest <commit of the release tag>\n' "$(attestation_command "$1")"
    printf 'dipo install: To install without the attestation check (the SHA-256 checksum is still checked), set DIPO_SKIP_ATTESTATION=1.\n'
  } >&2
  exit 1
}

main() {
  check_platform

  version="${DIPO_VERSION:-}"
  case "$version" in
    "") base="https://github.com/$REPO/releases/latest/download" ;;
    [0-9]*) version="v$version" ;;
  esac
  if [ -n "$version" ]; then
    check_tag "$version" DIPO_VERSION
    base="https://github.com/$REPO/releases/download/$version"
  fi

  skip_attestation="${DIPO_SKIP_ATTESTATION:-}"
  case "$skip_attestation" in
    "" | 1) ;;
    *) fail "DIPO_SKIP_ATTESTATION must be 1 or unset, got: $skip_attestation" ;;
  esac

  install_dir="${DIPO_INSTALL_DIR:-${HOME:?HOME is not set}/.local/bin}"
  asset="dipo-darwin-arm64.tar.gz"

  command -v curl > /dev/null 2>&1 || fail "curl is required."
  command -v tar > /dev/null 2>&1 || fail "tar is required."

  # How the download is verified is settled before anything is downloaded (DIPO-321).
  source_digest=""
  if [ "$skip_attestation" = 1 ]; then
    say "DIPO_SKIP_ATTESTATION=1: the build provenance attestation is not checked; the checksum is."
  elif command -v gh > /dev/null 2>&1; then
    if [ -z "$version" ]; then
      version=$(gh api "repos/$REPO/releases/latest" --jq .tag_name) ||
        fail "gh could not read the latest release; nothing was installed. gh may need 'gh auth login' first."
      check_tag "$version" "the latest release tag"
      base="https://github.com/$REPO/releases/download/$version"
    fi
    # The commit the tag points at: the attestation must name it as its source (0016 rule 4).
    source_digest=$(gh api "repos/$REPO/commits/$version" --jq .sha) ||
      fail "gh could not read the commit of $version; nothing was installed. gh may need 'gh auth login' first."
    case "$source_digest" in
      *[!0-9a-f]*) fail "gh returned no commit for $version, got: $source_digest" ;;
    esac
    [ "${#source_digest}" -eq 40 ] || fail "gh returned no commit for $version, got: $source_digest"
  else
    fail_without_gh "$asset" "$base"
  fi

  work=$(mktemp -d "${TMPDIR:-/tmp}/dipo-install.XXXXXX")
  staged=""
  # Removes the download directory and, after a failure, the half-written binary.
  trap 'rm -rf "$work"; if [ -n "$staged" ]; then rm -f "$staged"; fi' EXIT
  trap 'exit 1' HUP INT TERM

  say "downloading $asset (${version:-latest release})"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$work/$asset" "$base/$asset" ||
    fail "could not download $base/$asset"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$work/SHA256SUMS" "$base/SHA256SUMS" ||
    fail "could not download $base/SHA256SUMS"

  expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1; exit }' "$work/SHA256SUMS")
  [ -n "$expected" ] || fail "SHA256SUMS has no entry for $asset."
  actual=$(sha256_of "$work/$asset")
  if [ "$actual" != "$expected" ]; then
    fail "checksum mismatch for $asset: expected $expected, got $actual. Nothing was installed."
  fi
  say "checksum ok"

  if [ -n "$source_digest" ]; then
    say "verifying the build provenance attestation of $version ($source_digest) with gh"
    # Accepts only attestations signed by release.yml running on main, for the tag's commit
    # (0016 rule 4).
    if ! gh attestation verify "$work/$asset" --repo "$REPO" \
      --signer-workflow "$SIGNER_WORKFLOW" --source-ref "$SOURCE_REF" \
      --source-digest "$source_digest"; then
      fail "attestation verification failed for $asset; nothing was installed. gh may need 'gh auth login' first."
    fi
  fi

  mkdir "$work/extract"
  tar -xzf "$work/$asset" -C "$work/extract" dipo || fail "$asset does not contain dipo."
  if [ ! -f "$work/extract/dipo" ] || [ -L "$work/extract/dipo" ]; then
    fail "$asset does not contain a regular file dipo."
  fi

  mkdir -p "$install_dir" || fail "cannot create $install_dir"
  # Same directory as the target, so the rename below is atomic and never crosses filesystems.
  staged="$install_dir/.dipo.install.$$"
  cp "$work/extract/dipo" "$staged"
  chmod 755 "$staged"
  mv -f "$staged" "$install_dir/dipo"
  staged=""
  say "installed $install_dir/dipo"

  "$install_dir/dipo" --version || fail "$install_dir/dipo does not run."

  case ":${PATH:-}:" in
    *":$install_dir:"*) ;;
    *) say "$install_dir is not on your PATH. Add it, for example: export PATH=\"$install_dir:\$PATH\"" ;;
  esac
}

main "$@"
