---
id: DIPO-82
title: Run package managers through Aikido Safe-Chain inside the worker sandbox
status: To Do
assignee: []
created_date: '2026-10-15 11:00'
updated_date: '2026-10-15 14:10'
labels:
  - 'tier:M'
milestone: m-0
dependencies: []
references:
  - packages/engine/src/workers/claude-cli/safe-chain.ts
  - packages/engine/src/workers/claude-cli/plan.ts
  - packages/engine/src/workers/claude-cli/adapter.ts
  - packages/engine/src/workers/claude-cli/self-test.ts
  - packages/engine/src/workers/types.ts
  - packages/engine/src/host/main.ts
  - packages/engine/test/workers/safe-chain.test.ts
  - packages/engine/test/workers/plan.test.ts
  - packages/engine/test/workers/self-test.test.ts
  - packages/engine/test/workers/launch-checks.test.ts
  - packages/engine/test/host/files.test.ts
  - packages/engine/src/workers/claude-cli/launch-checks.ts
  - packages/engine/src/host/protocol.ts
  - packages/engine/src/index.ts
  - packages/daemon/src/runs.ts
  - packages/engine/test/host/host.test.ts
  - packages/engine/test/run/adapter.test.ts
  - packages/engine/test/workers/launch-fixtures.ts
  - docs/decisions/0008-worker-adapter.md
priority: high
ordinal: 73000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: on a machine that uses Aikido Safe-Chain (https://github.com/AikidoSec/safe-chain), a worker inside the dipo sandbox can run bun, npm, npx, pnpm, yarn, bunx, pip and the other commands Safe-Chain wraps, and they go through the official Safe-Chain install (~/.safe-chain), without opening the sandbox to anything else.

Context: found in the DIPO-55 hand test (2026-10-15). The worker's `bun test` failed with exit 127 `safe-chain: no such file: /safe-chain-wrapper.sh`. The maintainer's shell sources Safe-Chain init scripts that find their own directory with `cd $(dirname ...)`; the sandbox denies that read, the directory comes out empty, and the wrapper path is wrong. Also ~/.bun/bin/bun is a symlink to a company wrapper outside `~/.safe-chain`, which workers do not need. The worker sandbox today allows reads of ~/.bun, ~/.npm and ~/.cache only, has an empty network allowlist and no local binding; Safe-Chain checks installs through a local proxy and Aikido's malware list. The maintainer's choice: workers use the official Safe-Chain only, not the full company symlink setup. Machine-specific settings belong in .dipo/office.local.yaml, never in the repository.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Investigation first, without a live Claude session: reproduce the failure with dipo's own sandbox runtime and the run's settings, and record in the notes exactly which reads, environment, PATH entries, network domains and local binding Safe-Chain needs for a plain command (bun test) and for an install (bun add).
- [ ] #2 When Safe-Chain is present, the worker's commands resolve bun and the other wrapped package managers through the official ~/.safe-chain install, not through ~/.bun/bin symlinks into other directories, and a plain `bun test` in the worktree runs inside the sandbox with exit 0.
- [ ] #3 Any extra sandbox access Safe-Chain needs is the smallest that works, read-only where possible, machine-local (office.local.yaml or detected at launch), shown in dipo run --dry-run, and never includes the maintainer's other project directories or credentials.
- [ ] #4 A machine without Safe-Chain launches exactly as before.
- [ ] #5 Automated tests cover the launch plan with and without Safe-Chain, and the sandbox self-test (DIPO-43) or a new check reports clearly when Safe-Chain is present but unusable in the sandbox.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Investigation (AC #1), 2026-10-15, no Claude session

Reproduced with the bundled srt 0.0.79 CLI, settings equal to the run's worker sandbox (`denyRead` on the home directory as Claude Code's `blockReadsOutsideWorkingDirectories` adds it, `allowRead` worktree, temp, `~/.bun`, `~/.npm`, `~/.cache`; Keychains denied; network closed; no local binding), a tiny Bun project under DIPO_TMP, the daemon's PATH, Safe-Chain 1.5.12, Claude Code 2.1.300.

Root cause: not the sandbox read. Claude Code's Bash tool sources a shell snapshot (`~/.claude/shell-snapshots/snapshot-zsh-*.sh`) before every command. The snapshot is made outside the sandbox by sourcing `~/.zshrc` and keeps every function, but no plain shell variables (PATH comes from the claude process env). `~/.zshrc` loads the official init and then the company `safe-chain-symlinks` init, which defines a `safe-chain` function whose body is `command "$ABSOLUTE_SELF_DIR/safe-chain-wrapper.sh"`. `ABSOLUTE_SELF_DIR` is not in the snapshot, so the call becomes `/safe-chain-wrapper.sh` (exit 127). Sourcing the snapshot reproduces the exact message even outside any sandbox. Inside the sandbox, sourcing either init script fails as well (`operation not permitted`), because home reads are blocked.

Second problem: `~/.bun/bin/bun` and `bunx` are symlinks into a company symlink directory under `~/Projects`. With that directory first on PATH, Safe-Chain's own `bun` lookup finds the symlink, cannot read the target in the sandbox, and fails ("Is 'bun' installed"). The real binary is `~/.bun/bin-originals/bun`, which the daemon's PATH lists first today.

Minimum for a plain command (`bun test`, exit 0), measured one grant at a time:
- reads: `~/.safe-chain/scripts` (the init script finds itself with `cd $(dirname ..)`), `~/.safe-chain/bin` (the `safe-chain` binary), `~/.safe-chain/certs` (safe-chain opens `certs/ca-key.pem` at start even for `bun test`; without it: EPERM). Not needed: the `newPackagesList_*` files, the company directory.
- environment: the official shell functions (`bun`, `npm`, ... calling `wrapSafeChainCommand`) and `safe-chain` resolving to `~/.safe-chain/bin/safe-chain`; no extra variables.
- PATH: a directory with the real package manager binary before any directory whose `bun` is a symlink outside the readable paths; `~/.safe-chain/bin` (the init appends it).
- network: none. Local binding: none.
- the company `safe-chain` function must not be defined, so the snapshot must not be sourced.

Install (`bun add is-number@7.0.0`, project and caches in temp dirs only), additionally:
- local binding: `allowLocalBinding: true` (safe-chain's proxy listens on 127.0.0.1; without it: `listen EPERM 127.0.0.1`).
- network: `registry.npmjs.org` and `malware-list.aikido.dev` (without the latter: "Error fetching js malware database: Forbidden").
- writes: TMPDIR (safe-chain writes `safe-chain-ca-bundle-*.pem` there) and the Bun install cache (`bun is unable to write files to tempdir` otherwise).
- optional: read/write of `~/.safe-chain` for its malware-list cache; without it safe-chain warns and fetches again.

Fix verified in the same harness: a run-directory shell wrapper sets PATH and `ZDOTDIR` to a run-directory `.zshenv` that sources only `~/.safe-chain/scripts/init-posix.sh`; `~/.claude/shell-snapshots` is read-denied so the snapshot's company function never loads. Result: `bun` is the official function, `safe-chain` is `~/.safe-chain/bin/safe-chain`, `bun test` exits 0. With the snapshot readable it fails again with the original message.

## Implementation (2026-10-15)

- `workers/claude-cli/safe-chain.ts`: `detectSafeChain` at launch (official `~/.safe-chain/bin/safe-chain` plus `scripts/init-posix.sh`; no config key). The worker PATH drops entries the worker sandbox cannot read and moves to its end entries whose wrapped command resolves to an unreadable file (here `~/.bun/bin`, `/opt/homebrew/bin` with a company `pip3`), so `~/.bun/bin-originals/bun` wins.
- Plan, only with Safe-Chain: `CLAUDE_CODE_SHELL=<runDir>/safe-chain/zsh` (wrapper: exports PATH and `ZDOTDIR`, execs zsh; `.zshenv` sources only the official init; bash uses `BASH_ENV`), `allowRead` + `~/.safe-chain/{bin,scripts,certs}` and the wrapper directory, `denyRead` + `~/.claude/shell-snapshots`. No network, no local binding, no writes. Both files are run-directory files, so `dipo run --dry-run` prints them (with the PATH decisions as comments) next to the settings file.
- Self-test: with Safe-Chain and `bun` on PATH, the one Bash command first runs `bun run --version` through the worker shell; perl records `safe-chain exit <n>`; non-zero refuses with "Safe-Chain is installed at ..., but `bun run --version` through it exited N inside the worker sandbox". `bun --version` was not usable: Safe-Chain starts its proxy for it (needs local binding).
- Measured in the srt harness: with the grants `safe-chain exit 0` and `bun test` passes; without `certs` `safe-chain exit 1`.
<!-- SECTION:NOTES:END -->
