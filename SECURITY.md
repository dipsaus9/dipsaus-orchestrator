# Security policy

## Reporting a vulnerability

Please do not open a public issue, discussion or pull request for a security problem.

Report it privately through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**, or go straight to <https://github.com/dipsaus9/dipsaus-orchestrator/security/advisories/new>.

Include what you found, the version (`dipo --version`) or commit, and the steps to reproduce it. The maintainer replies in the advisory, fixes the problem in a private fork when needed, and publishes the advisory with the release that contains the fix.

## Supported versions

`dipo` is in early development (0.x). Only the latest release and `main` receive security fixes.

## How dependencies are watched

- Renovate raises update and vulnerability pull requests (`renovate.json`). Security fixes never merge without review.
- `bun audit --audit-level=high` runs daily and on every pull request that changes `bun.lock` (`.github/workflows/audit.yml`). A failing daily run opens or updates one issue labelled `security`.
- Dependency review runs on every pull request; CodeQL, secret scanning and push protection are enabled on the repository.
