# 0017 Testing strategy and configuration format

Status: Proposed (spike DIPO-14, 2026-10-10).

## Context

Decision 0003 requires tests and a verify command from the first line of code. Decision 0004 fixes the tools: TypeScript on Bun, zod 4, `bun test` with only the `describe`/`it`/`expect` subset, and one verify command (`format:check && lint && typecheck && bun test`) used locally, by workers and in CI. That composition stays as it is.

Two problems are specific to this project:

1. **The engine drives Claude Code.** A test that starts a real `claude -p` costs tokens, needs the maintainer's Max login, is slow and gives different output each time. The engine must still be tested on the paths that matter most: parking, budget overruns, crashes and permission waits.
2. **The engine drives git and Backlog.md.** Branches, worktrees and task files are the product's core facts (0001). Mocks of git would hide the failures we care about.

The office also needs one configuration format (0011): tiers mapped to model, budget and loop cap, timeouts and script overrides now, role files later (M4).

Ownership: DIPO-4 owns budgets and the on-disk state layout, DIPO-5 the Worker contract and what tiers map to, DIPO-9 what a script override means, DIPO-6 whether Ink render tests run under `bun test`, DIPO-10 the token-savings measurement. This ADR owns the test layers, the fake worker and its recordings, and the configuration file format, location, validation and versioning.

### Verified facts about Claude Code output (2026-10-10)

- `claude -p --output-format stream-json` writes one JSON object per line. `--verbose` is used with it; `--include-partial-messages` adds `stream_event` lines; `--include-hook-events` adds hook lifecycle events (`hook_started`, `hook_progress`, `hook_response`). `SessionStart` and `Setup` hook events are always included; `Notification`, `SessionEnd`, `PreCompact` and `PostCompact` never produce `hook_started` [1][2].
- Message types include `system` (`init`, `api_retry`, `permission_denied`, `compact_boundary` and others), `assistant`, `user`, `stream_event` and a final `result` [1][4].
- `system/init` carries `session_id`, `claude_code_version`, `cwd`, `model`, `tools`, `mcp_servers`, `plugins`, `permissionMode` and an optional `capabilities` list for feature detection [1][4].
- `result` has `subtype` `success`, `error_max_turns`, `error_during_execution`, `error_max_budget_usd` or `error_max_structured_output_retries`, plus `is_error`, `num_turns`, `duration_ms`, `duration_api_ms`, `total_cost_usd`, `usage`, `modelUsage` (per model), `permission_denials` and `terminal_reason` [4].
- Usage: each `assistant` message has `message.id` and `message.usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`). Parallel tool calls share one id, so usage is counted once per id. Per-message `output_tokens` is a placeholder; real output counts arrive in `message_delta` stream events and in the result. Result `usage` excludes subagents; `modelUsage` and `total_cost_usd` include them. On `error_max_budget_usd`, `usage` leaves out the response that crossed the cap. A crash result may carry zeroed totals [5].
- `--permission-prompts none` denies anything that would prompt; denials appear as `system/permission_denied` and in `permission_denials` [1][2]. Hook input always has `session_id`, `transcript_path`, `cwd`, `hook_event_name`; the `Notification` hook has matchers such as `permission_prompt`, `idle_prompt` and `agent_needs_input`; there are `PermissionRequest` and `PermissionDenied` events [3].
- SIGTERM ends the run with exit 143 and no result for the open turn. SIGINT ends the turn first [1].
- `--max-turns` and `--max-budget-usd` are print-mode caps; spend can pass the budget cap [2].

### Verified facts about Bun and config parsing (local probes on Bun 1.3.5 and on 1.4.2, the version 0004 pins)

- Bun imports `.toml`, `.yaml`, `.jsonc` and `.json5` files natively [6]. Runtime APIs on 1.4.2: `Bun.YAML.parse`/`stringify`, `Bun.TOML.parse`/`stringify`, `Bun.JSONC.parse`, `Bun.JSON5.parse`/`stringify`. Bun 1.3.5 had only `Bun.TOML.parse` and `Bun.YAML.parse`/`stringify` [13].
- `Bun.YAML.parse` follows YAML 1.2 (`no: no` and `on: yes` stay strings), throws `SyntaxError` on invalid input, returns an array for a multi-document file, and resolves anchors and `<<` merge keys silently [7][13].
- `Bun.YAML.stringify` drops comments (parsing to an object loses them) and by default writes everything in flow style on one line (`{version: 1,tiers: {...}}`); block style needs an indent argument [13].
- `bun test` finds `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*` and skips hidden directories. CLI path filters are substring matches. `bunfig.toml` `[test]` supports `root`, `preload`, `pathIgnorePatterns`, `randomize`, `seed`, `retry` and others [9][10]. `bun test --timeout=<ms>` sets the per-test timeout, default 5000 ms [13].
- `setSystemTime` fixes `Date.now` and `new Date()` in `bun:test`; the docs do not say that `setTimeout` is faked [8].
- A test file whose `describe` is registered only when an environment variable is set passes cleanly without it, on both 1.3.5 and 1.4.2 (`Ran 1 test across 2 files`, exit 0; with the variable, 2 tests) [13].

## Options

### Testing

- **A. Real Claude in tests.** Most realistic. Costs tokens, needs a login, cannot run in CI, nondeterministic. Rejected for any automated layer.
- **B. Hand-written fake events at the Worker interface.** Cheap and deterministic, but tests our own idea of Claude's output, not its real output. Adapter parsing is untested.
- **C. Replay recorded stream-json sessions through the real adapter.** Deterministic and free, tests the real parser against real output. Needs a capture and refresh process. Chosen, with B allowed for engine tests that do not care about Claude.

For git and Backlog.md: mocking the `git` and `backlog` binaries was rejected. Both are fast enough to run for real in temporary directories.

### Configuration format

| Criterion | YAML | JSON / JSONC | TOML |
|---|---|---|---|
| Human editing, nesting for tiers and roles | Good; indentation errors possible | Noisy braces and quotes | Good for flat keys, awkward for nested lists |
| Comments | Yes | JSON no, JSONC yes | Yes |
| Bun 1.4.2 runtime parse | `Bun.YAML.parse` (YAML 1.2) | `JSON.parse`, `Bun.JSONC.parse` | `Bun.TOML.parse` |
| Bun 1.4.2 runtime write | `Bun.YAML.stringify` (drops comments, flow style by default) | `JSON.stringify` (drops comments) | `Bun.TOML.stringify` (comments lost on parse) |
| Comment-preserving rewrite | `yaml` library document API [11] | None in Bun | None in Bun |
| Frontmatter for role files (prose plus metadata) | Common convention; Backlog.md task files in this repo use it | Rare | Rare (`+++`) |
| Ecosystem fit | `backlog/config.yml` is YAML | `tsconfig`, `.oxlintrc.json` | `bunfig.toml` |
| Editor completion from zod | JSON Schema via yaml-language-server | JSON Schema native | Tool support uneven |
| Pitfalls | Implicit types (reduced in 1.2), anchors | Trailing commas, no comments | Arrays of tables |

## Decision

### 1. Test layers

All layers are plain `bun test` files using `describe`/`it`/`expect`. No snapshot API: golden files are compared with `toEqual` and rewritten only when `DIPO_UPDATE_GOLDEN=1` is set.

| Layer | Covers | Location | Runs in |
|---|---|---|---|
| **Unit** | Pure logic: Ready gate, batch selection, branch and slug derivation, park-reason mapping, budget arithmetic, config parse, validation and migration, stream-json line parser, scrubber | next to source, `*.test.ts` | verify |
| **Contract** | zod schemas for commands and events: example fixtures parse, old fixtures still parse (compatibility), the generated JSON Schema files are current; every recording parses with the adapter schema | `packages/contract/test/`, `packages/engine/test/contract/` | verify |
| **Engine** | The engine as one unit with the fake worker, a real temporary SQLite file, an injected clock and id source, and real temporary git and Backlog.md fixtures where the scenario touches them. Asserts on emitted events, park reasons, database facts and git state | `packages/engine/test/engine/` | verify |
| **Integration** | Our wrappers around external tools on real temporary repositories: git (branches, worktrees, dirty trees, conflicts, existing branch), Backlog CLI (create, edit, status, parse output), repository scan (DIPO-9), daemon and client over a real Unix socket | `packages/*/test/integration/` | verify; slow ones CI only |
| **TUI** | Ink components rendered from golden event logs produced by engine tests, via `ink-testing-library`. Client side only; no daemon | `packages/tui/test/` | verify (tooling confirmed by DIPO-6) |
| **Live** | Real `claude -p` runs: recording capture and a manual smoke run | `tools/recordings/` scripts, not test files | never automated |

The compile smoke test of the binary stays in CI outside `bun test` (0004, DIPO-13).

**Verify versus CI only, inside `bun test`.** CI-only files are named `*.ci.test.ts` and register their `describe` only when `DIPO_TEST_CI=1`:

```ts
if (process.env.DIPO_TEST_CI === "1") {
  describe("daemon survives client exit", () => { /* ... */ });
}
```

CI sets `DIPO_TEST_CI=1` and runs the same `bun run verify`. Local verify and workers skip those files. A test goes CI only when it is slow (budget: the whole local `bun test` under about 60 seconds), needs process lifecycles that are timing sensitive (detached daemon, kill and restart), or needs a platform matrix. Correctness rules never go CI only.

**Timeouts.** The Bun default of 5000 ms per test stays for unit, contract, engine and TUI tests. A slower integration test sets its own limit with the third argument of `it(name, fn, timeoutMs)`, which is part of the 0004 subset and works the same in other runners. No global `--timeout` is added to verify; if CI runners prove slower, CI may pass `bun test --timeout` without changing the verify composition. A raised timeout never lifts the 60-second total budget.

**Test plans.** A story's test plan (DIPO-8) names its automated entries in terms of these layers (for example "engine: hold parks with `on-hold`"). Manual entries, such as the live smoke run before a release, follow the manual test flow of 0002.

### 2. The fake worker

The fake replaces the **subprocess**, not the adapter. The platform module's spawn is injectable (0004). In tests it returns a fake process whose stdout, stderr, exit code and signal come from a recording. The real Claude CLI adapter (DIPO-5) parses it and the real engine reacts. This tests parsing, event mapping and engine behaviour against real Claude output.

For engine tests that need no Claude detail, a `ScriptedWorker` implements the Worker interface directly from a short list of Worker events. It must never emit something the adapter could not produce from a recording; a contract test checks each script against the adapter's event schema.

**Recording format.** One directory per scenario:

```
packages/engine/test/recordings/claude-cli/<scenario>/
  stream.jsonl   # one line per observed item, in arrival order
  meta.json      # how it was made and what it should cause
```

Each `stream.jsonl` line is our envelope: `{ "t": <ms since start>, "ch": "stdout" | "stderr" | "hook" | "exit", "data": ... }`. `stdout` holds one stream-json object, `hook` holds a hook payload received by the adapter's hook relay (DIPO-5), `exit` holds `{ code, signal }`. `meta.json` holds `claude_code_version` (from `system/init`), the flags used, capture date, fixture repo hash, prompt size in bytes and its sha256 (never the prompt), the scenario's expected outcome, and `synthetic` or `derivedFrom` when not captured live.

**Replay.** The fake advances the injected clock by the recorded `t` deltas instead of sleeping, so a 20-minute recording replays in milliseconds. Steering is honoured from the recording: on SIGINT the fake jumps to the recorded post-interrupt tail; on SIGTERM it emits `exit` with code 143 and no result, as Claude Code does [1]. Writes to stdin (stream-json input) are recorded by the fake so tests can assert on them.

**Scenarios.** Captured live unless marked; derived ones are produced by small transforms in code (`derive.ts`), so they regenerate on every refresh.

| Scenario | Source | Engine behaviour under test |
|---|---|---|
| `success-single` | live | Run completes, usage stored, story advances |
| `success-tools-subagent` | live | Tool events, `parent_tool_use_id`, usage deduplicated by message id, subagent usage from `modelUsage` |
| `max-turns` | live, `--max-turns 1` | `error_max_turns` maps to the loop-cap path |
| `budget-cli-cap` | live, tiny `--max-budget-usd` | `error_max_budget_usd` parks with `budget-exceeded`; cost taken from `total_cost_usd`, not `usage` |
| `budget-engine-cap` | `success-tools-subagent` with a low tier budget in test config | Engine sees live usage pass the budget, interrupts, parks `budget-exceeded`, never raises the budget |
| `permission-denied` | live, `--permission-prompts none` | `system/permission_denied` and `permission_denials` reach the engine as a signal |
| `permission-wait` | live with a fixture permission host, or derived; mechanism set by DIPO-5 | Story shown as needing the maintainer (state name from DIPO-6), parks after the configured wait |
| `interrupt` | live, SIGINT mid-run | Turn ends with a result; steering path works |
| `terminated` | derived: SIGTERM, exit 143, no result | Run marked failed, usage recovered from assistant messages, resume possible |
| `crash-truncated` | derived: stream cut mid-line, non-zero exit | Parser survives a partial line; failure recorded, story not lost |
| `crash-zeroed` | derived: `error_during_execution` with zeroed totals | Usage recovered from earlier messages, not overwritten with zero [5] |
| `api-retry-rate-limit` | synthetic from documented `system/api_retry` fields | Retries shown; limit errors surface as such, not as failure of the story |
| `stall` | derived: 30-minute gap in `t` | Stall detection fires on the injected clock |
| `compaction` | live if it can be provoked cheaply, else synthetic | Compaction recorded as an event; usage stays correct |
| `resume` | live pair: run, then `--resume` | Session resume; resumed totals include earlier spend and are not double counted [5] |
| `worker-park-ambiguous` | live once DIPO-5 fixes how a worker reports a park; the fixture story makes the worker report fixture-controlled text only | Worker-reported park reason (`ambiguous-spec`) is stored with its text |

`verify-failing`, `conflict`, `scope-violation` and `review-blocked` are decided by engine code from git, verify and reviewer results, and `on-hold` by the maintainer's `dipo hold` command. They are engine and integration tests with a successful recording, not special recordings.

**Permission waits.** `claude -p` with no permission host denies a prompt at once [1], so a plain live run cannot show a wait. The capture uses a fixture permission host, for example `--permission-prompt-tool` pointing at a fixture MCP server that never answers [2], and records the hook relay's `PermissionRequest` or `Notification` (`permission_prompt`) payload. If that proves impractical, the scenario is derived from `permission-denied` by replacing the denial with a recorded or documented wait payload and a gap in `t`, and is marked derived. How the adapter detects a wait in production is DIPO-5's decision; this recording follows it.

**Capture.** `bun run recordings:capture <scenario>` (a dev script, never a test) does this:

1. Creates a synthetic fixture repository in a temp directory from `test/fixtures/repos/<name>`. Never a real project.
2. Runs `claude -p --output-format stream-json --verbose --include-partial-messages --include-hook-events` with the scenario's flags, plus `--setting-sources project`, `--strict-mcp-config` and a fixture `--settings` file, so the maintainer's user hooks, plugins and MCP servers stay out of the session.
3. Captures every line with its arrival time, the hook relay's payloads and the exit status into memory.
4. Scrubs (below) and writes only the scrubbed result. The raw stream is never written to disk.

**Scrubbing.** The scrubber is code with unit tests, and it fails the capture rather than writing anything doubtful. It works from an **allowlist per channel and message type**: for each `ch` and, on `stdout`, each `type`/`subtype` (and each hook event name on `hook`), it lists the structural, id and usage fields that are kept. Every other string, at any depth, is redacted to `"[redacted sha256:<12 hex> len:<n>]"`. A message type or hook event the allowlist does not know is redacted whole, keeping only `type`, `subtype` or `hook_event_name`, and is reported at capture time so the allowlist can be extended in review.

- **Kept as is:** `type`, `subtype`, block types, tool names, `stop_reason`, `is_error`, `parent_tool_use_id` (normalised), `model`, `claude_code_version`, `permissionMode`, `terminal_reason`, `hook_event_name`, Notification matcher type, exit `code` and `signal`, and every usage and numeric field: `message.usage` on assistant messages, `usage` in `message_start` and `message_delta` events, result `usage`, `modelUsage`, `total_cost_usd`, `num_turns`, `duration_ms`, `duration_api_ms`, and `permission_denials` reduced to tool names and ids.
- **Always redacted (examples, not an exhaustive list, since anything not allowlisted is redacted):** user message text, assistant `text` and `thinking` blocks, text deltas, `tool_use.input`, tool results, `result.result`, `structured_output`, `errors` text, every `stderr` line, and hook payload strings such as `UserPromptSubmit` `prompt`, `tool_input`, `tool_response`, the `Notification` `message` and the `Stop` `last_assistant_message`.
- **Identifiers normalised:** `session_id`, `uuid`, `prompt_id`, message ids and tool use ids map to stable placeholders (`session-1`, `msg-3`), consistently within a recording so deduplication by message id still works.
- **Paths normalised:** the temp directory, home directory, `cwd`, `transcript_path` and `scratchpad_dir` become `${WORKDIR}`, `${HOME}`, `${TRANSCRIPT}` and `${SCRATCHPAD}`.
- **Park-report exemption:** once DIPO-5 fixes the channel through which a worker reports a park reason and its text, that one field gets an explicit allowlist entry so engine tests can assert on the stored text. It is safe only because the recording's fixture story makes the worker report fixed, fixture-controlled text; the secret scan still runs over it.
- **Secret scan:** after scrubbing, the output is scanned for known token shapes (`sk-ant-`, `ghp_`, `github_pat_`, AWS keys, `Bearer `, private key headers) and for the real home path. Any hit aborts the capture. The same scan runs as a unit test over every committed recording, so a hand-edited recording cannot add a secret.

**Usage for DIPO-10.** Recordings keep all usage fields listed under "kept as is", plus prompt size and hash in `meta.json`. A unit test asserts that scrubbing changes no usage number (raw and scrubbed usage compared during capture and stored as a checksum). DIPO-10's measurement code is tested against these recordings; the measurement itself runs on real stories and lives in the state database (DIPO-4). Tests assert on behaviour (events, park reasons, which usage fields were read), not on exact token counts, except tests of the usage arithmetic, which read the expected numbers from the recording itself.

**Storage and refresh.**

- Recordings are plain `.jsonl` in git, small (target under 200 KB each) and reviewable in a diff.
- Refresh is a normal story: run `recordings:refresh` (captures all live scenarios and regenerates derived ones), commit, and let the reviewer check the diff. Triggers: a Claude Code minor version change on the maintainer's machine, an adapter parse warning in production, or a DIPO-5 contract change.
- The adapter parses with zod schemas that are strict on fields we use and tolerant of unknown message types and fields. Unknown types are logged once per run, so drift shows up in real runs before tests notice.
- `bun run recordings:status` (dev script) compares the local `claude --version` with each recording's `claude_code_version` and lists stale ones. It is not a test, because tests must not depend on installed binaries other than git and the pinned Backlog CLI.
- Synthetic recordings are allowed only where live capture is impractical, are marked `synthetic: true`, and cite the doc they were built from.

### 3. Integration on real repositories

- **Fixtures:** `withTempRepo(fn)` creates a directory under a short temp path (`/tmp/dipo-XXXX`; macOS limits Unix socket paths to about 104 bytes), runs `git init -b main`, applies a fixture tree, and removes it in a `finally` unless `DIPO_TEST_KEEP=1`. Helpers use `try`/`finally` inside `it`, so no hooks beyond the 0004 subset are needed.
- **Isolated git:** every git call in tests runs with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `HOME` set to the temp directory, fixed author and committer name, email and dates, and no signing. The maintainer's global git config, hooks and signing never affect a test.
- **Worktrees:** created through the same engine code the product uses (DIPO-7), inside the temp repo, so cleanup removes them. Tests cover worktree creation on an existing branch, a dirty worktree, a missing gitignored env file (vision section 7) and removal.
- **Remote:** a bare repository in the temp directory acts as `origin`, so push and fetch are real with no network.
- **Backlog.md:** the `backlog.md` npm package is a pinned devDependency (1.53.0 at the time of writing [12]), so `bun install` provides the CLI and every machine runs the same version. A fixture project generated once by that CLI is checked in under `test/fixtures/backlog/`; tests copy it and then change tasks only through the CLI, as the product does. The fixture is regenerated when the pin changes. Together with DIPO-7 (Backlog.md and git contract) and DIPO-8 (story standard), which own the behaviour, the fixture and integration tests cover at least: creating a draft with a temporary `DRAFT-n` id and promoting it at refine to a native id, with references to it rewritten; a story whose test plan field has automated and manual entries; a story whose test plan is not-applicable with a reason; and a story put on hold by hand.
- **Environment:** tests run with a cleaned environment: no `ANTHROPIC_*`, `CLAUDE_*` or `GH_*` variables, no network.

### 4. Determinism

- **Clock:** the engine reads time only through an injected `Clock` (`now()`, timers). Tests use a manual clock that the fake worker advances. A lint rule bans `Date.now`, `new Date()` without arguments and global timers outside the platform module (oxlint `no-restricted-globals`/`no-restricted-syntax`, or a grep test if oxlint cannot express it). `setSystemTime` is only a backstop for library code.
- **Ids:** an injected `IdSource`. Production uses sortable random ids; tests use sequential ids (`run-0001`). Recording ids are already placeholders.
- **Temp dirs and sockets:** one per test, never shared, never in the repository.
- **Order:** tests may not depend on order. `bunfig.toml` sets `randomize = true`; an order failure is pinned down with `--seed` while debugging.
- **No retries** to hide flakiness: `retry` stays 0. A flaky test is a bug.

### 5. Configuration format: YAML

**YAML 1.2, parsed with `Bun.YAML.parse` behind the platform module, validated with zod.** Reasons: comments and readable nesting for hand editing, a built-in parser on our runtime, the same format as Backlog.md's `config.yml`, and YAML frontmatter is the natural shape for role files, which are mostly prose instructions plus a little metadata. One format covers both. TOML is the runner-up: Bun 1.4.2 parses and writes it, but it is unusual as role frontmatter and has no comment-preserving writer. JSON lost on comments; JSONC is parseable on 1.4.2 but noisy to edit and has no comment-preserving writer either.

Mitigations for YAML's pitfalls: YAML 1.2 removes most implicit booleans; zod rejects wrong types with the key path; a file must hold exactly one document (`Bun.YAML.parse` returns an array for several, which validation rejects). Anchors and merge keys are resolved by the parser before validation, so they cannot be detected afterwards; the docs discourage them and the result is still validated.

**Location in the repository (committed):**

```
<repo>/.dipo/
  office.yaml        # office configuration, version 1
  roles/<name>.md    # role files from M4: YAML frontmatter + instructions
  office.local.yaml  # optional, machine-specific overrides; never committed
```

`office.yaml` holds tiers (model, budget, loop cap per tier), timeouts and script overrides. The keys and their meaning belong to DIPO-4, DIPO-5 and DIPO-9; this ADR only fixes the shell:

```yaml
# yaml-language-server: $schema=https://<release-url>/office.schema.json
version: 1
tiers:
  S: { model: haiku, budget: 50000, loops: 3 }   # units from DIPO-5
timeouts:
  workerStallMinutes: 20
scripts:
  verify: bun run verify                        # meaning from DIPO-9
```

A role file has frontmatter with `version`, `name`, `purpose`, `tools`, `model`, `effort` and optional tier overrides; the Markdown body is the instructions. The fields are confirmed in M4.

**Machine-local, never committed:** the state database, logs, sockets, run knowledge from scans (0011 item 8) and `.dipo/office.local.yaml`. Where runtime files live is DIPO-4's decision. This ADR hands DIPO-4 these requirements:

- Runtime files are never among the committed files above, and the software-level office list (DIPO-3) is outside every repository.
- If any runtime file lives under `.dipo/`, office init writes a `.dipo/.gitignore` that ignores everything except `office.yaml`, `roles/` and itself, additively and removably (research idea 12). `office.local.yaml` is ignored in every case.
- Each run stores a hash of its effective configuration, plus which local overrides were active, so a run can be traced to the configuration it used.

**Precedence.** The committed `office.yaml` describes the office. Local overrides are limited to an allowlisted set of machine-specific keys (to start: `timeouts.*`); any other key in `office.local.yaml` is a validation error. Order, lowest to highest: built-in defaults < `.dipo/office.yaml` < allowlisted keys from `.dipo/office.local.yaml` < flags on a single command. Objects merge per key; lists and scalars replace. There is no user-level layer for office settings, because offices are isolated (0011). The overview shows when a local override is active.

**Validation.** Every file is validated with `z.strictObject` schemas, so unknown keys (typos) are errors. Errors name the file, the key path and the expected type. An office with invalid configuration refuses to start new runs and shows the error; other offices are unaffected; running workers keep the configuration they started with. Configuration is read at daemon start and on an explicit reload command, never mid-run.

**JSON Schema.** The zod schemas are exported with `z.toJSONSchema` to `office.schema.json` and `role.schema.json`, shipped with each release for editor completion. A contract test fails when the committed schema files differ from the export.

**Versioning and migration.**

- Every file has a required integer `version`. Each version has its own zod schema.
- Migrations are pure functions `vN -> vN+1` in code, chained, each with unit tests from fixture files.
- On load an older file is migrated in memory and works, with a warning naming `dipo config migrate`. That command is the only thing that rewrites a configuration file; it uses the `yaml` package's document API, which keeps comments [11], and the change shows up as a normal git diff for review. `Bun.YAML.stringify` is not used on hand-edited files because it drops comments and defaults to flow style [13].
- A file with a newer `version` than the binary knows is refused with a message to upgrade `dipo`. No guessing.
- Breaking a schema without a migration is a review-blocking finding.

## Consequences

- No automated test calls Claude or needs a login; verify runs anywhere with Bun and git.
- The adapter is tested against real Claude output, so format drift shows up when recordings are refreshed, not first in an overnight run.
- Recordings need upkeep: a refresh story after notable Claude Code updates, using the maintainer's subscription for a few cheap runs.
- Some failure paths (rate limits, crashes) rest on synthetic or derived recordings and are only as accurate as the docs they cite.
- Real git and Backlog CLI in tests make the suite slower than mocks; the 60-second budget and the CI-only split keep verify usable.
- The Backlog CLI becomes a pinned devDependency of this repository.
- Injected clock and ids add a little ceremony to engine code; lint keeps it honest.
- One format (YAML) for office and role files; the yaml library is added as a dependency only when `config migrate` is built.
- `.dipo/` becomes a committed folder in every office repository, created additively by office init and removable (research idea 12).

## Open questions for the maintainer

1. **YAML over TOML.** Accept YAML for office and role files? TOML is stricter and Bun 1.4.2 parses and writes it, but it is unusual as role frontmatter and no Bun writer keeps comments.
2. **Folder name.** `.dipo/` at the repository root, matching the command name? Alternative: `dipo/` (visible) or `.dipsaus/`.
3. **Local override file.** Keep `.dipo/office.local.yaml` limited to allowlisted machine-specific keys (`timeouts.*` to start), or drop it so committed configuration is the only source?
4. **Recording refresh cadence.** Refresh on demand (Claude Code minor update, parse warning), or on a fixed schedule such as monthly?
5. **Live smoke before release.** Should a release (DIPO-13) require the maintainer to run the manual live smoke test against real Claude once, or is it optional?
6. **Verify time budget.** Is about 60 seconds for local `bun test` the right limit before tests move to CI only?

## Sources

1. Claude Code docs, Run Claude Code programmatically (stream-json, `system/init`, `api_retry`, `--permission-prompts`, SIGTERM). https://code.claude.com/docs/en/headless
2. Claude Code docs, CLI reference (`--include-hook-events`, `--include-partial-messages`, `--max-turns`, `--max-budget-usd`, `--setting-sources`, `--strict-mcp-config`). https://code.claude.com/docs/en/cli-reference
3. Claude Code docs, Hooks reference (event list, common input fields, Notification matchers). https://code.claude.com/docs/en/hooks
4. Claude Code docs, Agent SDK TypeScript reference (`SDKMessage` union, `SDKResultMessage`, `SDKSystemMessage`, `SDKPermissionDeniedMessage`). https://code.claude.com/docs/en/agent-sdk/typescript
5. Claude Code docs, Track cost and usage (dedup by message id, placeholder output tokens, `usage` vs `modelUsage`, crash and budget results). https://code.claude.com/docs/en/agent-sdk/cost-tracking
6. Bun docs, File types (TOML, YAML, JSONC, JSON5 imports). https://bun.com/docs/runtime/file-types
7. Bun docs, YAML (`Bun.YAML.parse`, YAML 1.2, `SyntaxError`). https://bun.com/docs/runtime/yaml
8. Bun docs, Dates and times in tests (`setSystemTime`, fake timers). https://bun.com/docs/test/time
9. Bun docs, Test discovery (file patterns, hidden directories, filters). https://bun.com/docs/test/discovery
10. Bun docs, bunfig.toml `[test]` options. https://bun.com/docs/runtime/bunfig
11. `yaml` library docs (comments kept on documents; trailing comment handling not fully stable), npm `yaml` 2.9.1. https://eemeli.org/yaml/
12. npm registry, `backlog.md` 1.53.0 (`bin: backlog`). https://registry.npmjs.org/backlog.md/latest
13. Local probes, 2026-10-10, on Bun 1.3.5 (installed) and Bun 1.4.2 (binary from npm `@oven/bun-darwin-aarch64` 1.4.2, unpacked in a scratch directory, not installed). 1.4.2: `Bun.YAML` and `Bun.TOML` have `parse` and `stringify`, `Bun.JSONC` has `parse`, `Bun.JSON5` has `parse` and `stringify`; 1.3.5: only `Bun.TOML.parse` and `Bun.YAML.parse`/`stringify`. Both: `no: no` and `on: yes` stay strings; invalid YAML throws `SyntaxError`; a two-document file parses to an array; `<<: *anchor` is merged; `Bun.YAML.stringify` drops comments and writes flow style unless given an indent; an env-gated test file passes with and without the variable. `bun test --help` on 1.4.2: `--timeout` per-test default 5000 ms.
