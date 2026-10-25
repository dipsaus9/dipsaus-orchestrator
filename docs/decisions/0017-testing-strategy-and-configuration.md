# 0017 Testing strategy and configuration format

Status: accepted. First written 2026-10-10 (spike DIPO-14). Rewritten 2026-10-24 for the simplified design. The research behind the rewrite is in `docs/research/2026-10-24-simplification-audit.md`.

## Decision in short

- **Tests never call Claude.** They replay recorded Claude Code sessions through the real adapter.
- **Tests use real tools.** git and the Backlog CLI run for real in temporary directories.
- **Tests stay deterministic.** Time and ids are injected.
- **Configuration** is YAML in `.dipo/`, validated by strict zod schemas. It holds only keys that code reads, and every key has a default.

## Part 1. Testing

### 1. Test layers

All tests are plain `bun test` files using `describe`, `it` and `expect`. Golden files are compared with `toEqual`, and rewritten only with `DIPO_UPDATE_GOLDEN=1`.

| Layer | Covers | Where |
|---|---|---|
| Unit | Pure logic: the Ready gate, selection, slugs, caps, config parsing, the stream parser, the scrubber | Next to the source, `*.test.ts` |
| Contract | The zod schemas: fixtures parse, old fixtures still parse, the generated JSON Schema files are current, every recording parses | `packages/contract/test/`, `packages/engine/test/contract/` |
| Engine | The engine as one unit, with the fake worker, a real `dipo.db` in a temporary state directory, an injected clock and ids, and real git and Backlog fixtures | `packages/engine/test/engine/` |
| Integration | Our wrappers on real temporary repositories: git, the Backlog CLI, the scan, the daemon and client over a real socket, the box backend on macOS | `packages/*/test/integration/` |
| TUI | Ink components rendered from golden event logs | `packages/tui/test/` |
| Live | Real Claude: capturing recordings, and the maintainer's live smoke run before a release (0016) | `tools/recordings/`, never a test file |

- **CI-only tests.** Files named `*.ci.test.ts` register their tests only when `DIPO_TEST_CI=1`, which a lint rule checks. CI sets it. Local `bun test` stays under about 60 seconds, and a slow or timing-sensitive test goes CI only. Correctness rules never go CI only.
- **Timeouts.** Bun's default per-test timeout stays. The CI command passes each test's CI timeout on the command line. A slow test sets its own with `it(name, fn, ms)`.
- **Isolation from the live daemon.** Every test process carries `DIPO_TEST=1`, and its own `DIPO_HOME` and `DIPO_RUNTIME_DIR` under `DIPO_TMP` (fallback `/tmp`), from `packages/testkit/src/test-env.ts`. With that marker, dipo refuses the maintainer's real state, log and runtime folders. Temp paths stay short, because a socket path must fit 100 bytes (0005).

### 2. The fake worker

The fake replaces the **subprocess**, not the adapter. The platform module's spawn is injectable. In tests it returns a process whose output and exit come from a recording, the real Claude adapter parses it (0008), and the real engine reacts. For engine tests that need no Claude detail, a `ScriptedWorker` emits worker events directly. A contract test checks that every script could come from a recording.

**Recordings.** One directory per scenario: `packages/engine/test/recordings/claude-cli/<scenario>/`, holding `stream.jsonl` and `meta.json`.
- Each line of `stream.jsonl` is `{ t, ch: stdout | stderr | exit, data }`. (Older recordings may carry `hook` lines from before 2026-10-24; replay ignores them.)
- `meta.json` holds the Claude Code version, the flags, the capture date, the prompt's size and hash (never the prompt), the expected outcome, and `synthetic` or `derivedFrom` when the recording was not captured live.

**Replay.** The fake advances the injected clock by the recorded time steps instead of sleeping. SIGINT jumps to the recorded tail, and SIGTERM ends with exit 143 and no result.

**Scenarios** cover what the engine decides from a session's output:
- success, with tools and subagents;
- the CLI's turn backstop and the engine's token cap;
- an interrupt, a SIGTERM, a stream cut mid-line, zeroed crash totals;
- a rejected plan limit and an API retry;
- `apiKeySource` not `none`, and an unplanned model;
- a start failure (auth, billing, start-up), an invalid report, a prompt that is too long;
- a stall, a compaction, a blocked report with a question;
- stream drift.

Scenarios whose outcome code decides from git, CI or the reviewer are engine tests with a successful recording, not special recordings.

**Capture.** `bun run recordings:capture <scenario>` is a dev script, never a test:
1. It builds a synthetic fixture repository in a temp directory, never a real project.
2. It runs `claude` with the launch plan the adapter itself builds.
3. It holds every line in memory, then scrubs it and writes only the scrubbed result. The raw stream never touches disk.

**Scrubbing.** The repository is public, so the scrubber works from an allowlist per channel and message type. It keeps the structural fields, ids, usage numbers and every field the adapter maps to a decision. Every other string becomes `[redacted sha256:<12 hex> len:<n>]`.
- **Normalised.** Ids become stable placeholders. Paths become `${WORKDIR}`, `${HOME}` and the like.
- **Unknown types** are redacted whole and reported.
- **A secret scan** for known token shapes and the real home path aborts the capture on any hit. It also runs as a unit test over every committed recording.

**Refresh** is on demand: after a Claude Code minor update, an adapter drift notice (0008), or a change to the adapter. `bun run recordings:status` lists recordings older than the installed Claude Code.

### 3. Real repositories

- **Temp repositories.** `withTempRepo` creates a repository under a short temp path, applies a fixture tree, and removes it afterwards unless `DIPO_TEST_KEEP=1`.
- **Isolated git.** Every git call in tests runs with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `HOME` set to the temp directory, fixed authors and dates, and no signing.
- **A real remote.** A bare repository in the temp directory is `origin`, so push and fetch are real, with no network.
- **The Backlog CLI** is the pinned `backlog.md` devDependency. A fixture project generated by that CLI is checked in, and tests change it only through the CLI, as the product does.
- **A clean environment.** Tests run with no `ANTHROPIC_*`, `CLAUDE_*` or `GH_*` variables and no network.

### 4. Determinism

- **Time.** The engine reads time only through an injected `Clock`, and a lint rule bans `Date.now`, `new Date()` and global timers outside the platform module.
- **Ids** come from an injected `IdSource`; tests use sequential ids.
- **Order.** `bunfig.toml` sets `randomize = true`, and `retry` stays 0: a flaky test is a bug.

## Part 2. Configuration

### 5. Format and files

YAML 1.2, parsed with `Bun.YAML.parse` behind the platform module and validated with zod. YAML gives comments, readable nesting, the same format as Backlog.md's `config.yml`, and the natural frontmatter for role files (M4).

```
<repo>/.dipo/
  office.yaml        # the office's configuration (committed)
  roles/<name>.md    # role files from M4: YAML frontmatter plus instructions
  .gitignore         # office.local.yaml
  office.local.yaml  # machine-local; never committed
<state>/config.yaml  # software settings: daemon.autostart, spend alerts, notify.desk (0005, 0009)
```

A sample `office.yaml`. Every key is optional and has a default; the keys and their meaning belong to the ADRs named in the comments.

```yaml
# yaml-language-server: $schema=https://<release-url>/office.schema.json
version: 14
tiers:            # 0008
  S: { model: haiku,  effort: low,    budgetTokens: 300000,  maxTurns: 90,  maxMinutes: 45,  loops: 3 }
  M: { model: sonnet, effort: medium, budgetTokens: 800000,  maxTurns: 200, maxMinutes: 90,  loops: 5 }
  L: { model: opus,   effort: high,   budgetTokens: 2000000, maxTurns: 300, maxMinutes: 180, loops: 8 }
review: { model: opus, effort: high, maxRounds: 3, maxTurns: 60, maxMinutes: 30, budgetTokens: 200000 }  # 0002
caps: { ciAttempts: 2, conflictAttempts: 2 }                       # 0002
merge: { autoMerge: true, holdLabels: [] }                         # 0002
box: { files: [], localPorts: [] }                                 # 0008
scan: { model: sonnet, effort: low, budgetTokens: 100000, maxMinutes: 5 }  # 0013
story: { bannedPhrases: [...], securityPhrases: [...] }            # 0012
prompt: { contractMax: 12000 }                                     # 0014
base: main                                                         # 0010
worktree: { root: "../{repo}.worktrees" }                          # 0010
scripts: { verify: bun run verify }                                # 0013
```

### 6. Precedence and validation

- **Precedence**, lowest to highest: built-in defaults, then `office.yaml`, then the allowlisted keys of `office.local.yaml`, then flags on a single command. Objects merge per key, and lists and scalars replace. There is no user-level layer, because offices are isolated.
- **The local file** accepts only `timeouts.*`, `privacy.*` and `retention.*`. `privacy.*` and `retention.*` are accepted only there: in the committed file they are an error that names the key and points to the local file.
- **Strict schemas.** `z.strictObject` turns an unknown key into an error that names the file, the key path and "this key may need a newer dipo". An office with an invalid file starts no new runs and shows the error; other offices are unaffected.
- **When config is read.** At daemon start, on `office.reloadConfig`, and whenever a fetch changes the file on the base. A run keeps the configuration snapshot it started with (`runs.config_hash`, 0007).
- **JSON Schema.** The schemas are exported to `office.schema.json` and `config.schema.json` for editor completion. A contract test fails when the committed files differ from the export.

### 7. Versioning

- Every file has a required integer `version`. A file newer than the binary is refused with "upgrade dipo".
- **One reset to version 14.** It keeps only the keys code reads, and gives every key a default. One migration takes any file from versions 1 to 13 to version 14, and drops retired keys with a warning that names them.
- **After version 14,** adding a key with a default needs no version bump. A version changes only when a key's meaning or shape changes, and then a pure migration function from the previous version comes with it, tested on fixture files.
- **Rewriting a file.** Only `dipo config migrate` rewrites a configuration file. It uses the `yaml` library's document API, which keeps comments, and the change shows as a normal git diff.

## Replaced

- A version bump for every added key (2026-10-12). It produced 13 office versions in 15 days. Replaced by the reset to version 14 and defaults (2026-10-24).
- About 150 office keys across 17 sections, including `permissions`, `sandbox`, `storyPr`, `mergeSlot.requiredChecks`, `scope.*`, `worker.plugins`, `worker.web`, and `worktree.files`, `ports`, `env` and `post_create`. Each served a mechanism that is gone (2026-10-24).
- `sandbox.toolchainReadPaths` in the local file, with its `.npmrc` checks (2026-10-18). Gone with the Mac sandbox (0008).
- Recordings and scenarios for the permission wait, `needs-permission`, credit holds and the Mac sandbox safety checks (2026-10-10, 2026-10-12). Gone with the box (0008); the escape probe is the box's safety test.
- Recording usage kept for 0014's measurement. The measurement left 0014 (2026-10-24); the usage fields are still kept for the usage arithmetic tests.
