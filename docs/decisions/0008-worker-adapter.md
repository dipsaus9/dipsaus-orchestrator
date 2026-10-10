# 0008 Worker adapter and the Claude Code CLI adapter

Status: Proposed (spike DIPO-5, 2026-10-10). All ten open questions answered by the maintainer on 2026-10-10; the body follows the answers.

## Context

The engine runs agents through a small `Worker` contract and the first adapter wraps the Claude Code CLI as a subprocess on the maintainer's Max login (0001, 0011). This ADR fixes that contract, the Claude adapter, the caps per tier, how usage and plan limits surface, and how they map onto the events of 0005.

Fixed by earlier decisions: TypeScript on Bun, adapters under `engine/src/workers/` (0004). One detached worker host per run spawns the process, appends every line to `events.ndjson` with a byte offset, takes steering on a small socket and writes `exit.json`; the engine parses the file and advances the offset in the same transaction as the facts it derives (0006 decision 8). Commands `work.steer`, `work.answer`, `work.pause`, `work.resume`, `work.reassign`, `work.stop`, `work.discard`, events `work.*`, `usage.updated`, `question.*`, `story.parked`, park reasons including `stopped` and `interrupted`, and the `run.hostAlive` rule come from 0005. Tiers map to model, budget and loop cap in `.dipo/office.yaml` (0011, draft 0017). The prompt layers, the report the worker returns, the resume rule and the flag requirements (no git writes, `backlog` or `gh`; nobody answers prompts; no Claude commit guidance) come from draft 0014. Draft 0017 replays recorded stream-json through this adapter and leaves the permission-wait mechanism and the report channel to this ADR. 0010 lists what the office installs and how it is removed. Research ideas 3, 4, 8, 12 and 15 are acceptance criteria here.

### Verified Claude Code behaviour (code.claude.com/docs, read 2026-10-10)

Each line cites the Sources list. Items marked **[unverified]** are not in the docs and must be confirmed by a live recording (0017) before the first M0 story relies on them. Claude was not run for this spike.

Launch and I/O
- `-p` runs headless. `--output-format stream-json` writes one JSON object per line; the last line of a turn is a `result` [1][2]. `--input-format stream-json` reads user messages from stdin; in this mode each user turn emits its own `result` [1][3]. Message shape: `{type:"user", message:{role:"user", content}, parent_tool_use_id:null}` [4][5]. `priority` sets when a message sent during a running turn arrives: `next` or absent, read in the same turn as soon as running tool calls finish; `later`, held until the turn ends; `now` without a human origin, the turn is interrupted and the message read next [4].
- `--tools` limits the built-in tools; on macOS and Linux the `default` set leaves out Glob and Grep [1].
- After a turn finishes and stdin is closed, the run waits for background work, by default at most 10 idle minutes [2].
- `--append-system-prompt-file` appends to the default prompt. The prompt is recorded on the first request and reused on `--resume` until compaction [1].
- `--session-id <uuid>` sets the id up front; `--resume <id>` finds a session by id in any project on the machine; `--fork-session` branches [1][9].
- `--model` takes `haiku`, `sonnet`, `opus`, `fable` or a full id; `--effort` takes `low` to `max` and falls back to the highest level the model supports [1][12].
- A safety classifier can re-run a flagged request on another model, and the session stays on that model [12].
- `--json-schema` gives a validated `structured_output` on the result (print mode only) [1][2]. Whether it applies to every turn under `--input-format stream-json` is **[unverified]**.
- `--bare` skips hooks and CLAUDE.md, and also never reads the subscription login, so it cannot be used on Max [2][11].
- In `-p` an `ANTHROPIC_API_KEY` in the environment is always used over the subscription login. `claude auth status` prints JSON with `authMethod` (`claude.ai` for a subscription) [1][11]. `system/init` carries `apiKeySource` (`ANTHROPIC_API_KEY`, `apiKeyHelper`, `/login managed key`, `none`, `user`, `project`, `org`, `temporary`) [4]. A claude.ai login is expected to show `none`, the value for no API key; a live recording confirms it.

Permissions
- Without a flag a `-p` run starts in a built-in mode that can be `auto`, so the mode must always be passed [2].
- `--permission-prompts none` (v2.1.259+): anything that would prompt is denied unless a `PermissionRequest` hook allows it. Claude is told not to retry, `AskUserQuestion` is removed. Denials appear as `system/permission_denied` (best effort) and in the result's `permission_denials` (authoritative) [1][2][4].
- `PermissionRequest` hooks run in sessions that cannot show a prompt; with no decision the call is denied [6]. Command hooks time out after 600 s by default [6].
- `--permission-prompt-tool` routes prompts to an MCP tool and the run waits for it [1][2].
- Rules are evaluated deny, then ask, then allow; a deny cannot be carved out by an allow. A bare tool name in `--disallowedTools` removes the tool. Bash rules match the command text and are not a security boundary (`sh -c`, paths) [1][8].
- `bypassPermissions` skips checks; `dontAsk` denies anything not pre-allowed [2].
- Path rules: `Read(./x)` is relative to the current directory, `~/` and `//` anchor at home and root; a deny also matches a symlink's target. Read and Edit denies cover the file tools, recognised Bash file commands (`cat`, `head`, `sed`, `tee`) and redirections, but not a script that opens files itself [8]. `permissions.blockReadsOutsideWorkingDirectories` makes the file tools refuse reads outside the working directories in every mode [8][16].
- A `-p` run never shows the trust dialog. The project's settings hooks, `env` block and `apiKeyHelper` are still used, `.mcp.json` servers connect, only project `permissions.allow` is ignored [8].

Bash sandbox [17]
- OS-enforced (macOS, Linux, WSL2) around Bash commands and every process they start. Default writes: working directory, a per-user temp directory and added directories; reads: most of the machine, including `~/.ssh`. Network: only through a proxy whose allowed domains start empty. Protected paths (`.claude` settings and hooks, `.mcp.json`, `.git/hooks`, `.git/config`, most of `~/.claude` including `.credentials.json`) stay write-denied.
- From a linked worktree the sandbox allows writes to the main repository's shared `.git` (not `hooks/` or `config`) so `git commit` works [17]. `blockReadsOutsideWorkingDirectories` also covers sandboxed commands: it denies home and user roots and re-opens the working directories, the shared `.git`, the session temp directory and the global git config [16].
- Locks that keep repository settings from loosening a sandbox set in `--settings` need v2.1.285 [17].
- File tools, WebFetch, hooks and MCP servers run outside it and follow permission rules. The docs call the Bash sandbox alone insufficient for fully unattended runs and point to the sandbox runtime (`srt`), which wraps any process in the same isolation [19].
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` strips credentials from Bash, hook and MCP server environments but leaves GitHub tokens [18].
- Keys: `sandbox.enabled`, `failIfUnavailable` (exit at startup instead of running unsandboxed, which is the default when the sandbox cannot start), `allowUnsandboxedCommands: false` (no unsandboxed retry; set from `--settings` it also makes repository settings unable to loosen the sandbox), `filesystem.allowWrite`/`denyWrite`/`denyRead`/`allowRead` (narrower path wins, a deny holds inside a wider allow), `network.allowedDomains`, `network.strictAllowlist` (refuse other hosts in every mode), `credentials` (deny file reads and unset variables for sandboxed commands; repository files cannot set it), `excludedCommands`. Sandboxed commands run without a prompt (`autoAllowBashIfSandboxed`, default true), explicit deny rules still apply.

Hooks and settings
- `--settings <file|json>` sits above local, project and user settings for the session; list keys such as hooks and permission rules merge across sources [7][6]. `--setting-sources` limits which files load [1].
- Hook input always has `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`; subagent hooks add `agent_id` [6]. Useful events: `SessionStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Notification` (`permission_prompt` after about six seconds), `SubagentStart`/`SubagentStop` (with `agent_transcript_path`), `Stop` (with `last_assistant_message`), `StopFailure` (error category, for example `rate_limit`), `PreCompact`/`PostCompact`, `PostModelSwitch`, `SessionEnd` [6].
- With `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` the stream carries `session_state_changed` with `idle`, `running` or `requires_action` [4].

Usage and limits
- Each `assistant` message has `message.id` and `message.usage`; parallel tool calls repeat one id, so count once per id. Per-message `output_tokens` is a placeholder; the result carries the real count [3].
- Result fields: `subtype` (`success`, `error_max_turns`, `error_max_budget_usd`, `error_during_execution`, `error_max_structured_output_retries`), `num_turns`, `duration_ms`, `duration_api_ms`, `total_cost_usd`, `usage`, `modelUsage` per model (tokens, cache read and creation, `costUSD`, `contextWindow`), `permission_denials`, `terminal_reason`, `api_error_status`, `startup_failure_reason` [4].
- `usage` covers one turn and only the main loop; `total_cost_usd` and `modelUsage` are running totals that include subagents and, from v2.1.277, spend restored on resume. A crash result may carry zeros; then input and cache tokens are recoverable from assistant messages, output and subagent tokens are not. `total_cost_usd` is a client-side estimate from a bundled price table [3].
- Caps: `--max-turns` (in stream-json input every queued user message gets its own limit), `--max-budget-usd` (checked against the estimate, can be overshot, ignores restored totals) [1][3]. There is no CLI flag for a token cap or wall-clock cap. The SDK has an alpha `taskBudget` in tokens; no CLI equivalent is documented [4].
- Plan limits: `rate_limit_event` with `status` `allowed`, `allowed_warning` or `rejected`, `resetsAt`, `utilization`, and `errorCode: "credits_required"` when included usage is exhausted [4]. Retryable failures emit `system/api_retry` with `error` `rate_limit`, `overloaded` and others; Claude Code retries up to 10 times [2][10]. Interactive sessions can wait for a reset; no `-p` equivalent is documented [10]. Limits come as session, weekly, or per model family (Opus, Sonnet); session and weekly cover all models, a family limit only that family [10]. The documented `rate_limit_event` has no scope field, so how a `-p` run tells the scopes apart, and the exact stream when a limit is hit, are **[unverified]**.
- Assistant messages carry `error` (`rate_limit`, `billing_error`, `authentication_failed`, ...) [4]. During a tool call the stream emits `tool_progress` with `heartbeat: true` every 30 s [4].

Exit and resume
- Exit 0 on success, non-zero on failure. A failure inside the run is printed as the result on stdout; a bad flag goes to stderr before start [2].
- SIGTERM: exit 143, the turn is left unfinished with no result, `SessionEnd` hooks run. SIGINT ends the turn [2]. Whether the process stays alive for more stdin after SIGINT in stream-json input is **[unverified]**.
- Resume restores history and model but not `--settings`, `--mcp-config` or `--add-dir`, which must be passed again; a `-p` resume starts in the mode a new run would. A cut-off tool call is marked so Claude checks its effect [9]. Transcripts live at `~/.claude/projects/<dir>/<session-id>.jsonl`, subagents in a nested `subagents/` folder; the format is internal and changes between versions; retention is 30 days (`cleanupPeriodDays`) [9][6].

Terms: OAuth login is meant for ordinary use of Claude Code by the subscriber; developers may not route others' requests through plan credentials, and Agent SDK products should use API keys. A user signing in to the unmodified binary with their own subscription is allowed. Advertised plan limits assume ordinary individual use [13].

## Options

**Process shape.** A. One `claude -p` per user turn, resumed for each later turn: simple, but every steer costs a new process and a cache round trip. B. One long-lived `claude -p --input-format stream-json` per run, steered over stdin (chosen): matches 0006's host, steer and answer are writes, the cache stays warm. C. Interactive TUI in a PTY (agent-orchestrator's way): needs screen scraping, against "code decides".

**Unattended permissions.** A. `bypassPermissions`: no guard at all. B. `auto`: a classifier decides, not code. C. `dontAsk`: deterministic, but skips `PermissionRequest`, so no way to ask the maintainer. D. Mode `default` with `--permission-prompts none`, explicit allow and deny lists, and an engine `PermissionRequest` hook (chosen): deterministic, and code decides when to ask the maintainer (section 5). E. `--permission-prompt-tool` to an engine MCP server: works, but needs an MCP server per run and blocks the run on our process.

**Isolation.** Permission rules alone match command text, and a script the worker writes and runs through an allowed command escapes every Bash deny and every Read deny [8]. A. Rules plus a post-turn git check: misses pushes, network calls, secret reads and writes outside the worktree. B. Claude Code's Bash sandbox in strict mode, plus scoped file rules (chosen): the OS bounds writes and network for every subprocess [17]. C. A container or VM per run: strongest, but a second runtime to install and keep in sync with the maintainer's toolchain; kept as a later option if B proves too leaky.

**Report channel.** A. `--json-schema` (chosen, if per-turn behaviour holds). B. Fenced JSON block in the last text (fallback). C. An engine MCP tool `report` (option if A fails in streaming mode).

**Budget unit.** A. Estimated USD at list price: weights model, caching and output in one number, but depends on a price catalog and is an estimate. B. Raw tokens (chosen, open question 1): input, output and cache creation count, cache reads are shown but do not count. Fair because each tier has a fixed model, so a tier's tokens always mean the same model. C. Turns ignore size. D. Time ignores model. Estimated USD is still computed for reports (section 4).

## Decision

### 1. The Worker contract (adapter-neutral, `engine/src/workers/types.ts`)

An adapter has a launch half, run by the worker host, and an interpret half, a pure parser run by the engine over `events.ndjson`. The engine never parses CLI output elsewhere.

```ts
interface WorkerAdapter {
  id: string;                                         // "claude-cli"
  probe(): Promise<AdapterStatus>;                    // version, login kind, capabilities; refuses below minimum
  plan(spec: WorkerSpec): LaunchPlan;                 // pure: argv, env, files for the run dir, first stdin lines
  encode(op: SteerOp): HostOp[];                      // pure: steer, answer, pause, stop -> stdin writes and signals
  interpret(line: HostLine, state: ParseState): { events: WorkerEvent[]; state: ParseState };  // pure
  result(state: ParseState, exit: ExitRecord): WorkerResult;                                    // pure
  canResume(ref: SessionRef, spec: WorkerSpec): ResumeCheck;          // transcript present, version, prompt hash
}
WorkerSpec = { run, agent, kind: "implement" | "review", workdir, model, effort, caps: Caps,
               systemFile, taskMessage, tools: { allow: string[], deny: string[] },
               session: { id: string, resume: boolean }, reportSchema, hookRelay: boolean }
Caps = { budgetTokens: number, maxTurns: number, maxMinutes: number }   // loops stay in the engine
SteerOp = { kind: "steer" | "answer", text } | { kind: "pause" | "stop" | "kill" }
HostOp  = { write: string } | { signal: "SIGINT" | "SIGTERM" | "SIGKILL" } | { closeStdin: true }
WorkerEvent =
  | { t: "started", sessionId, model, version, permissionMode, tools }
  | { t: "activity", kind: "text" | "tool" | "subagent", tool?, path?, agentId? }
  | { t: "output", text }                         // feeds work.output
  | { t: "usage", messageId, model, agentId?, input, cacheCreate, cacheRead }   // once per message id
  | { t: "turn", report: WorkerReport | null, totals: UsageTotalsByModel, numTurns, terminal }
  | { t: "waiting", on: "permission" | "question" | "plan-limit" | "retry" | "auth", detail, until? }
  | { t: "denied", tool, reason }
  | { t: "limit", status, utilization?, resetsAt?, creditsRequired? }
  | { t: "compacted", preTokens } | { t: "modelSwitched", from, to }
WorkerReport = { status: "done" | "blocked", criteria: { n: number, met: boolean, evidence: string }[],
                 summary: string, commitSubject: string, question?: string, notes?: string,    // 0014
                 needsPermission?: { tool: string, action: string } }   // blocked on a denied call (section 5)
WorkerResult = { outcome: "done" | "blocked" | "capped" | "plan-limit" | "stopped" | "reassigned" | "crashed" | "startFailed",
                 report: WorkerReport | null, usage: UsageTotalsByModel, sessionId, resumable: boolean,
                 park?: { reason: ParkReason, detail: string } }
```

Rules: start is `plan` plus a host spawn; stream is `interpret` over the event file, so replay after a daemon restart is the same code path; steering is `encode` through the host socket; the result comes from `result` once `exit.json` exists. The engine decides phase, loops, verify, commits and parks. The adapter only reports facts and proposes a park.

### 2. The Claude CLI launch

Minimum Claude Code version 2.1.285: the locks that stop repository settings from loosening a sandbox set through `--settings` (ignored `excludedCommands`, `allowedDomains`, `allowWrite`; `strictAllowlist` overriding repository domains) need it [17]. It also covers restored totals (2.1.277), `--permission-prompts` and `capabilities`. `probe` runs `claude --version` and `claude auth status` and refuses below the minimum or with anything but `authMethod: "claude.ai"`, with an `engine.notice`, so overnight work never runs unlocked or bills an API key by accident.

The host starts Claude with an allowlisted environment, not the daemon's: `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `TERM`, `TMPDIR`, the office's declared tool variables, plus `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, `DIPO_RUN`, `DIPO_HOST_SOCKET`. So `ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`, `AWS_*` and similar never reach the worker. The scrub strips credentials from Bash, hooks and MCP servers but leaves GitHub tokens in place [18], hence the allowlist and the `credentials` entries below.

```
claude -p --input-format stream-json --output-format stream-json --verbose
  --session-id <uuid> | --resume <uuid>          # engine-made uuid, stored on the run
  --model <m> --effort <e>                       # tier, role override wins
  --max-turns <tier maxTurns>                    # backstop only; the token budget is the engine's
  --permission-mode default --permission-prompts none
  --tools <role tool list>                       # rules and sandbox live in the run settings file
  --settings <run>/claude-settings.json --setting-sources project,local
  --strict-mcp-config --mcp-config <office mcp.json>
  --append-system-prompt-file <run>/system.md --exclude-dynamic-system-prompt-sections
  --json-schema <report schema>
```

The task message (0014 L4) goes in as the first stdin line, never on argv, so it is not visible in `ps`. `--setting-sources project,local` keeps the maintainer's user hooks and plugins out; project `CLAUDE.md` still loads (0014 L3). At worktree setup the engine copies the main checkout's `.claude/settings.local.json` into the worktree when present, under 0010's setup rules for copied files (it must be gitignored). The CLI has no token cap, so there is no budget flag: the engine enforces the token budget itself (section 6), and `--max-budget-usd` is not passed, because a USD backstop would need a catalog conversion of the token budget for little gain. `--max-turns` remains the process backstop, also while the daemon is down.

**Tools and rules.** `--tools` is explicit per role, `Read,Edit,Write,Glob,Grep,Bash` for the developer role, because the default set lacks Glob and Grep [1]; WebFetch, WebSearch and every MCP tool not in the office's `mcp.json` stay out. The worker is started in the worktree, so `./` is the worktree. Allow: `Read(./**)`, `Edit(./**)`, `Write(./**)`; Bash needs no allow rule because sandboxed commands run without a prompt. `permissions.blockReadsOutsideWorkingDirectories: true` fences the file tools, and sandboxed commands, to the worktree. Deny (0014 plus secrets, the backlog, git metadata and Claude settings): `Edit(./.git)`, `Edit(./.git/**)`, `Edit(./backlog/**)`, `Edit(./.dipo/**)`, `Edit(./.claude/settings.json)`, `Edit(./.claude/settings.local.json)`, `Read(./**/.env*)`, `Read(~/.ssh/**)`, `Read(~/.aws/**)`, `Read(~/.config/gh/**)`, `Read(~/.gnupg/**)`, `Read(~/.netrc)`, `Bash(git commit *)` and the other git write verbs, `Bash(git push *)`, `Bash(backlog *)`, `Bash(gh *)`. These rules guide the model and stop the obvious forms; the sandbox and the backstop below are the boundary.

**Sandbox.** The run settings file turns on the Bash sandbox with `enabled: true`, `failIfUnavailable: true` (a run never starts unsandboxed; the adapter reports `startFailed`), `allowUnsandboxedCommands: false`, no `excludedCommands`, `network.strictAllowlist: true` with `allowedDomains` empty by default. Set from `--settings`, these make the sandbox admin-required, so repository files cannot loosen it, and a repository's `strictAllowlist` has no effect [17]. The engine installs dependencies at worktree setup (0010), so workers need no registry; a dependency added mid-story is installed by the engine after the turn. An office may list registry hosts.

Every filesystem and credentials path in the run settings file is absolute, because how `./` resolves in a `--settings` file is not documented. Writes: the worktree and the sandbox temp directory, with `denyWrite` on `<worktree>/backlog`, `<worktree>/.dipo` and the two `<worktree>/.claude` settings files (also protected paths [17]). Reads: `blockReadsOutsideWorkingDirectories` also covers sandboxed commands. It denies the home directory and other user roots, then re-opens the worktree, the shared `.git` of a linked worktree, the session temp directory and the global git config [16]. An office toolchain list (default `<home>/.bun`, `<home>/.npm`, `<home>/.cache`) is re-opened with `allowRead` from `--settings`; whether that works under the block is recorded live. `credentials` deny entries cover `<home>/.ssh`, `<home>/.aws`, `<home>/.config/gh`, `<home>/.gnupg`, `<home>/.netrc` and the variables `GH_TOKEN`, `GITHUB_TOKEN`, `NPM_TOKEN`. Any settings scope may add deny entries and none can remove them; repository files cannot add masks [17].

On macOS a test or dev server that listens on a port needs `network.allowLocalBinding`, which also opens every localhost service to the command; on Linux a sandboxed command's localhost is private [17]. Offices turn it on only when verify needs it. Hooks and MCP servers run outside the sandbox [17], so the office `mcp.json` is reviewed like code and project hooks are refused (below). The docs state that the Bash sandbox alone constrains only shell commands [19]. Here the file tools are fenced by rules, the hooks are ours and the MCP servers are the office's. Running the whole worker inside the sandbox runtime stays a later hardening step.

**Linked worktrees and the shared `.git`.** The sandbox allows writes to the main repository's shared `.git` from a linked worktree (except `hooks/` and `config`) so `git commit` works [17][16]; protected paths cover only `hooks` and `config` [17]. That leaves two dangers. A refs change can damage other runs, because every story branch, the base and every worktree's index live in that one directory. Worse, the worker could rewrite `<main>/.git/worktrees/<this>/` (`commondir`, `gitdir`, `HEAD`, `config.worktree`) or the `<worktree>/.git` pointer file to point at a config with `core.fsmonitor` or `core.hooksPath`, and the engine's next git call would run that code with full access.

Option (a): absolute `denyWrite` on the whole `<main>/.git` and on `<worktree>/.git`, plus `Edit(./.git)` and `Edit(./.git/**)` for the file tools. Read-only `git status`, `diff` and `log` keep working, and the worker needs no git writes (0014). Option (b): allow the writes and detect changes afterwards. **Decided: (a)** (open question 9), because detection comes after the engine may already have run planted code. The docs say `denyWrite` blocks writes within allowed paths [17][16]; that it also beats the implicit shared-`.git` allowance is **[unverified]**. So every run is fail-closed: before each launch and resume a self-test runs sandboxed commands under the run's policy that try a write under `<main>/.git`, a write to the `<worktree>/.git` pointer, and `gh auth status`. `gh` keeps its token in the macOS Keychain, which the file rules do not cover, so `gh auth status` must fail inside the sandbox. If any of the three succeeds the run refuses to start (`startFailed`, `engine.notice`). "The narrower path wins" is documented for reads only [17].

These restrictions apply to workers and any other model session only. The engine is code: it runs git and `gh` outside the sandbox with the maintainer's own credentials (claim, commits, push, PR, branch deletion; 0010, 0014).

**Engine git calls.** The engine runs git outside any sandbox (snapshot, backstop, `ls-remote`, the commit at In Review, 0014), so every call is hardened: `GIT_CONFIG_NOSYSTEM=1`; `GIT_DIR` and `GIT_COMMON_DIR` set from paths recorded at run start, never read from the worktree; `-c core.hooksPath=/dev/null -c core.fsmonitor=false`; `commit --no-verify`. Before each call the engine checks that `<worktree>/.git`, `commondir` and `gitdir` still match the run-start snapshot. On a mismatch it parks `scope-violation` and runs no git in that worktree. This also keeps husky-style `core.hooksPath` hooks in tracked directories, which the worker may have edited, from running at the engine's commit.

**Env files.** Env files are copied (0010, maintainer decision 2026-10-10), so the worktree has the product's `.env*` files. The product's own scripts must load them and the model must not see them. So the sandbox does not deny them, and `Read(./**/.env*)` stops the Read tool and recognised file commands such as `cat`. A script the worker writes could still print them into its own context. With the network closed the value cannot leave the machine except through the model API itself. This residual risk is accepted with one rule (open question 8): worktree env files hold development secrets only. The first time the engine copies env files for an office it shows this rule once as an `engine.notice` and lists the files it copied.

**Project settings.** A `-p` run uses the project's settings hooks, `env` and `apiKeyHelper` without trust [8], and these could move a worker off the Max login or run code outside the sandbox. Before every launch and every resume, not only at pickup, the engine reads the worktree's `.claude/settings.json` and `.claude/settings.local.json` (the copy made at setup); if either defines `hooks`, `env`, `apiKeyHelper` or any MCP setting not on the office's allowlist (`worker.allowProjectSettings`), the run does not start and an `engine.notice` names the keys and the file. Refusing, not ignoring, is decided (open question 6). Any `sandbox` key in either file refuses the run the same way, so nothing in the repository can even try to change the sandbox. Worker writes to both files are denied (rules and sandbox above). Allow rules in the local file may let the worker skip a prompt; deny rules from `--settings` still win, and the sandbox still bounds Bash. Every run's `system/init` is checked: `apiKeySource` must be `none` and `model` must match the plan; otherwise the engine stops the worker and parks `worker-failed` with the notice.

**Backstop after every turn and at exit.** The engine compares with the snapshot taken at run start: HEAD and the checked-out branch (0014), the story branch and base locally and on the remote (`git ls-remote`), stashes, and `git status --porcelain -- backlog .dipo`. Ref updates the engine itself made since the snapshot, for this or other stories, are excluded through its own ref journal. Any other change parks the story `scope-violation` with the evidence. Draft 0017 should add live recordings that check: a denied `.env` read, a blocked write outside the worktree, to `<main>/.git` and to the `<worktree>/.git` pointer, an engine git call that ignores a planted `core.hooksPath` and `core.fsmonitor`, a refused network call and push, `gh auth status` failing in the sandbox (macOS Keychain), toolchain reads under the read block, `strictAllowlist` from `--settings` beating a repository domain, and the sandbox refusing to start.

**Engine steps on worker-written code.** Install and verify (0010, 0014) run the worktree's scripts and tests, which the worker may have written, as engine subprocesses outside Claude Code. Without a boundary they run with the maintainer's full access: `~/.ssh`, `gh` tokens, network, push. Decided (open question 10): the engine runs these steps through `@anthropic-ai/sandbox-runtime` (`srt`), which wraps any process in the same Seatbelt or bubblewrap isolation, takes a `--settings` file, denies network by default and lets `denyWrite` win over `allowWrite` [19]. A translator builds the `srt` settings file per run from the run policy, because the schema differs from Claude Code's [20]. On Linux `allowWrite` and `denyWrite` take literal paths (a trailing `/**` is dropped, other globs skipped), `denyRead` globs expand only to entries that exist when the command is wrapped, and an empty `allowedDomains` means no network. The policy: writes to worktree and temp, deny on `<main>/.git` and `<worktree>/.git`, `denyRead` on the secret paths, an allowlisted environment, network closed for verify. Install adds `allowWrite` on the toolchain caches (for example `<home>/.bun/install/cache`) and the office's registry hosts. `probe` checks `srt`'s Linux dependencies (`bubblewrap`, `socat`, `ripgrep`) and, on Ubuntu 24.04 and later, that `kernel.apparmor_restrict_unprivileged_userns` does not strip the user namespace [20]. The step is fail-closed: if `srt` is missing, fails `probe` or refuses to start, the run refuses (`startFailed`, `engine.notice`); install and verify never fall back to running unsandboxed. `srt` is an Apache-2.0 beta research preview whose formats may change [20][21], so the engine pins its version and the live safety recordings cover the translated file. This requirement amends 0010 (install, see Amends) and goes to draft 0014 (verify).

The run settings file holds `includeGitInstructions: false`, empty `attribution`, the permission rules and sandbox block above, and the hooks of section 5. Nothing else is configured outside the run directory.

### 3. Event mapping onto 0005

| Claude stream or hook | Worker event | 0005 effect |
|---|---|---|
| `system/init` | `started` | `work.assigned` (if not yet), model into `WorkRef.model`; version and `capabilities` stored on the run |
| `assistant` text, `tool_use` | `output`, `activity` | `work.output` (debounced 250 ms); activity feeds the DIPO-6 health derivation |
| `assistant.message.usage`, deduped by id; `parent_tool_use_id` set means subagent | `usage` | `usage.updated` (agent and run totals, at most 1/s) |
| `result` per turn | `turn` | Usage replaced by the result's cumulative `modelUsage`; budget tokens and estimated cost recomputed (section 4); `turns` from `num_turns`; report into `work.progress` (`criteriaMet`) |
| `tool_progress` heartbeat, any line | none (liveness) | The engine watchdog writes `work.observed no-output` when no line arrives for `timeouts.workerStallMinutes` (default 20, health `stuck`); `timeouts.workerQuietMinutes` (default 3) separates `quiet` from `busy` (0009) |
| `PermissionRequest` hook pending (primary); `session_state_changed requires_action` (secondary, to record live) | `waiting permission` | `work.observed input-wait`, plus `question.asked` (kind permission) when section 5 asks the maintainer |
| Report `status: blocked` with `question` | `waiting question` | `question.asked`; see section 6 |
| Report `status: blocked` with `needsPermission` | none | Park `needs-permission`; see section 5 |
| `system/permission_denied`, `permission_denials` | `denied` | Counted; three equal denials in a run give `work.observed same-failure` |
| `rate_limit_event`, `api_retry rate_limit`, assistant `error: rate_limit` | `limit`, `waiting plan-limit` | `work.observed plan-limit` (health `limited`, 0009); section 7 |
| `compact_boundary`, `PostCompact` | `compacted` | Stored as a fact (research 6.2) |
| `PostModelSwitch`, new model key in `modelUsage` | `modelSwitched` | Recorded on the run, `engine.notice`; usage stays per model (open question 7) |

Phase is never read from Claude. The engine sets `preparing` before spawn, `implementing` or `reviewing` while a worker runs, `verifying` while it runs verify (names final in DIPO-6). `Progress.loop`, `verify` and `reviewRound` are engine facts.

### 4. Usage per run and the pricing catalog (research ideas 3 and 4)

Per run and per agent the engine stores, per model: input, output, cache creation (5 minute and 1 hour split where `usage.cache_creation` gives it), cache read tokens, `num_turns`, `duration_ms`, `duration_api_ms`, wall time, permission denials, compactions, and the CLI's own `total_cost_usd` and `costUSD`. Live numbers come from deduped assistant messages; the result's cumulative `modelUsage` replaces them at each turn end. Subagent tokens per subagent come from messages with `parent_tool_use_id`, and are reconciled with `modelUsage` at turn end.

Budget (open question 1): the run's budget tokens are input plus output plus cache creation, summed over models, agents and subagents. Cache reads are stored and shown next to it but do not count. Live checks use input and cache creation from deduped messages; output joins at turn end, because per-message output is a placeholder [3], so the turn-end check is the exact one. On a resumed session the result's cumulative totals include the restored spend [3], so the engine adds only the change since the totals it stored at the last turn end.

Transcript tailing is the second source, not the first, because the format is internal [9]. The hook relay records `transcript_path` (`SessionStart`) and `agent_transcript_path` (`SubagentStop`). A tailer reads them from a stored byte offset (research idea 21), keeps only message id, model and usage, and ignores lines it does not understand. It runs in two cases: a worker host died without `exit.json`, and per-subagent detail the stream lacked. Its parser is version-gated by `claude_code_version` and covered by recordings. Session to story binding is certain because the engine chose the session id.

Estimated cost, for reports and the cross-check, never the budget: a versioned catalog in the engine (`engine/src/pricing/catalog-<n>.json`) lists per canonical model id the per-million rates for input, output, five-minute and one-hour cache writes and cache reads, with an effective date and source URL [14]. `estimatedCost` is the sum over models of tokens times rates; the run stores the catalog version so a number can be recomputed. The CLI's `costUSD` is kept beside it as a cross-check; a gap above 10% raises a notice that the catalog may be stale. The overview shows estimated cost next to the account's plan-limit `utilization` from the last `rate_limit_event`. DIPO-4 stores the columns.

### 5. Hooks: live state and the permission wait (research idea 3)

The run settings file registers command hooks, each `dipo hook <event>`, for `SessionStart`, `PermissionRequest`, `PostToolUse` (0014 nudges), `Notification`, `SubagentStart`, `SubagentStop`, `Stop`, `StopFailure`, `PostCompact`, `PostModelSwitch` and `SessionEnd`. The command reads the payload on stdin and passes it to the worker host over `DIPO_HOST_SOCKET`; the host appends it as a `ch: "hook"` line (0017 format), so hooks are replayed like stdout. It prints nothing, exits 0 within 2 s, and is silent on any failure, except for two cases. `PostToolUse` may return a 0014 nudge. `PermissionRequest` returns a decision.

Permission wait (open question 2: hybrid, decided by code). Office setting `permissions.ask`: `when-present` (default) or `never`.

- **Maintainer present.** With `when-present`, the maintainer counts as present when a client is connected (0006) and a command or read from a client arrived within `permissions.presentMinutes` (default 10); stream heartbeats do not count. Then the host asks the daemon, which emits `question.asked` (kind permission, tool and input summary) and `work.observed input-wait`. The hook blocks until `work.answer` allows or denies, or until `timeouts.permissionWaitSeconds` (default 300, hook timeout set 30 s above it) passes, then denies.
- **Otherwise deny at once.** Not present, `never`, a timeout or the daemon down: the hook returns no decision, the call is denied, Claude continues another way, and the denial is a signal.
- **Blocked on a permission.** If the worker cannot finish without the denied action, its report says `blocked` with `needsPermission` (tool and action). The engine parks the story `needs-permission` with the action as detail and keeps worktree, branch and session. The maintainer answers the park's permission question (`work.answer` with `decision: "allow" | "deny"`, a minor addition to 0005): **Allow once** resumes the same session, and for that resumed run only the engine's `PermissionRequest` hook allows the first request matching the recorded tool and action; **Deny** resumes it with the message "do it without <action>". An allow is never written as a rule or saved for later runs.

Recordings for 0017's `permission-wait` scenario use this hook with a fixture that never answers.

### 6. Steering, answers, pause and stop

Every op the engine sends is first stored as a pending intent on the run (`steer`, `answer`, `pause`, `stop`, `reassign`, `cap`), so the outcome is read from the intent, not guessed from the exit (section 7).

- `work.steer`: one user message with `priority: "next"` [4]. Claude reads it in the same turn once its running tool calls finish, so a correction lands before more work is wasted; `later` would let the worker finish a turn in the wrong direction. 0005's reply value `"next-turn"` reads as "no later than the next turn" and stays; a minor contract addition could name `"same-turn"`. If the run is paused or parked, the steer is stored and sent on resume.
- `work.answer` to a worker question: the worker reported `blocked` and the turn ended, so the process waits on stdin. The engine waits `timeouts.questionWaitMinutes` (default 15); an answer in time goes in as the next user message (`delivered: "now"`). Otherwise the engine closes stdin, the story parks `ambiguous-spec` with the question as detail, and a later answer resumes the native session with the answer as first message (`on-resume`).
- `work.pause`: a `priority: "now"` message "Paused by the maintainer: stop and reply only `paused`." interrupts the turn [4]; after that reply the engine sends no input and the process idles. A pause longer than 10 minutes closes stdin so the process exits; resume then uses `--resume`.
- `work.stop` and `work.reassign`: a `priority: "now"` stop message ends the turn, then the engine closes stdin, sends SIGTERM after 10 s and SIGKILL after 30 s (0004, 0006). SIGTERM gives exit 143 and no result; usage is taken from the last turn result plus later assistant messages [3].
- The turn cap per process is a backstop; the engine checks the run's totals after every `usage` and `turn` event and stops the worker at 100% of the tier's `budgetTokens`, `maxTurns` or `maxMinutes`. 0014's 80% nudge comes first. Turns are summed by the engine because `--max-turns` restarts with every queued message.

### 7. Exit, crash and plan-limit semantics

The pending intent decides first: `stop` gives `stopped` and parks `stopped` (0005); `reassign` ends the agent with no park and starts the new one (0005, 0006); `cap` gives `capped`; `pause` leaves the run paused. The table applies only when no intent explains the exit.

| Observed | Outcome | Engine action |
|---|---|---|
| Report `done`, stdin closed, exit 0 | `done` | Verify and commit at In Review (0014) |
| Report `blocked` with `question` | `blocked` | Section 6; park `ambiguous-spec` |
| Report `blocked` with `needsPermission` | `blocked` | Section 5; park `needs-permission`, session kept |
| `error_max_turns`, engine cap reached (tokens, turns, minutes) | `capped` | Park `budget-exceeded` with the cap that fired; never raise the budget |
| `error_max_structured_output_retries` or no valid report after a turn | none | One feedback turn "report in the schema", then park `ambiguous-spec` |
| `terminal_reason: prompt_too_long` | none | New session with a 0014 handoff once, then `budget-exceeded` |
| Exit 143 or a signal with no intent recorded | `crashed` | As the crash row |
| `apiKeySource` or `model` in `system/init` not as planned | `startFailed` | Stop the worker, park `worker-failed`, `engine.notice` (section 2) |
| `error_during_execution` with `startup_failure_reason`, or `authentication_failed`, `billing_error`, `account_on_hold` | `startFailed` | Stop scheduling for this adapter in all offices, `engine.notice`; the story stays Ready |
| Other `error_during_execution`, unexpected signal | `crashed` | Recover usage ([3], section 4). Resume once if budget remains and `canResume`, else park `worker-failed` with the last error as detail (open question 5) |
| Host dead without `exit.json` | `crashed` | First `work.observed host-lost` (health `lost`, 0009), then as the crash row |
| `rate_limit_event` `rejected`, or a turn ended by a 429 rate-limit error | `plan-limit` | See below |

`worker-failed` means the worker itself failed and one resume did not help; `interrupted` stays for a worker lost while the daemon was down (0006) that cannot be resumed.

Plan limits are not the story's fault, so they always wait for the reset, never park (open question 3). On `allowed_warning` the daemon stops starting new runs on the affected scope until the reset. On `rejected` the engine closes stdin and writes a wait fact on the run: `{ scope: "session" | "weekly" | "model:<family>" | "credits" | "unknown", resetsAt?, since }`. Scope comes from the limit message or event once a recording shows how `-p` reports it [10]; until then it is `unknown` and treated as `session`. The fact is what recovery after a daemon restart reads back to reschedule. The run shows `work.observed plan-limit` (health `limited`, no maintainer action). A session or weekly limit holds scheduling in every office; a model-family limit holds only runs on that family, others continue. The engine does not fall back to another tier's model: the model is part of the tier's quality and budget decision, and a silent switch would change both. Two minutes after `resetsAt` it resumes the native session with a short "continue" message. Without `resetsAt` it probes once an hour with the cheapest resume. There is no maximum wait: a weekly limit may hold a run for days, shown as `limited`. `errorCode: credits_required` has no reset coming, so it neither probes nor parks: the engine writes the wait fact with scope `credits`, holds the run as a paused run (stdin closed, session kept), holds new runs on this adapter in every office and raises an `engine.notice`. The maintainer deals with the plan and sends `work.resume` on a held run, which lifts the hold; if the error comes back, the same happens again. The engine never runs `/usage-credits` and never retries a 429 that reports exhausted usage.

### 8. Native resume first (research ideas 8 and 15)

Every run starts with an engine-made `--session-id`, stored on the run with the transcript path. Resume of the same story and role uses `--resume <id>` with the full flag set again (settings, MCP config and add-dir are not restored [9]) and the delta as first message, when 0014 section 6 holds and `canResume` confirms: the transcript file exists (30-day retention), `claude --version` and the L1+L2 hash match the run, and the session is not live in another host (`run.hostAlive`, 0006). Otherwise a new session with a 0014 handoff. The reviewer never resumes. After a daemon restart the host normally still runs (0006); only a dead host without `exit.json` leads here. Resume is used for: question answered after park, permission allowed or denied after a `needs-permission` park, plan-limit wait, pause past 10 minutes, `stopped`, `interrupted` or `worker-failed` then `work.resume`, crash retry. The token budget on resume is the run's remaining budget; restored totals are not counted twice (section 4).

### 9. Tiers to caps

| Cap | Claude CLI on Max | Enforced by |
|---|---|---|
| Model | `--model` alias or id | CLI |
| Effort | `--effort` | CLI |
| Budget (tokens: input + output + cache creation) | No CLI flag; `--max-budget-usd` not passed | Engine, from section 4 |
| Cache-read tokens | No CLI flag | Engine (shown, not counted) |
| Estimated USD at list price | Not passed | Engine (shown in reports, not capped) |
| Turns | `--max-turns`, per user message in streaming input | Engine total, CLI backstop |
| Wall time | No CLI flag | Engine (`maxMinutes`), plus stall detection |
| Loops (fix rounds) | Not a CLI concept | Engine (0001, 0002) |

```yaml
tiers:            # .dipo/office.yaml (shell from 0017); defaults, tuned after M0 measurement
  S: { model: haiku,  effort: low,    budgetTokens: 300000,  maxTurns: 60,  maxMinutes: 30,  loops: 3 }
  M: { model: sonnet, effort: medium, budgetTokens: 800000,  maxTurns: 120, maxMinutes: 60,  loops: 5 }
  L: { model: opus,   effort: high,   budgetTokens: 2000000, maxTurns: 200, maxMinutes: 120, loops: 8 }
worker: { adapter: claude-cli }
permissions: { ask: when-present, presentMinutes: 10 }
timeouts: { workerStallMinutes: 20, workerQuietMinutes: 3, questionWaitMinutes: 15, permissionWaitSeconds: 300 }
```

The token budgets are defaults to be tuned once M0 has measured real runs (0014's measurement). A role may override model, effort and adapter (0011); a role that changes the model should set its own budget, because the budget is fair only for a fixed model. `Usage.budget` in 0005 becomes `{ unit: "tokens", limit, used }`. Draft 0017's sample `budget: 50000` is in tokens, so it fits this unit; its value is a sample, not a default.

### 10. Additive and removable (research idea 12)

| Written | Where | Removed by |
|---|---|---|
| `system.md`, `claude-settings.json` (hooks, git instruction switches), report schema | Run directory in office state | Run retention (DIPO-4) |
| `mcp.json` | Office state directory | `office forget` |
| Copy of the main checkout's `.claude/settings.local.json` (gitignored) | Story worktree | Worktree teardown (0010) |
| Claude session transcript | Claude Code's own `~/.claude/projects/` | Claude Code's 30-day retention; dipo never purges them (open question 4) |

Nothing goes into the repository's tracked files, the main checkout's `.claude/`, `~/.claude/settings.json`, `.mcp.json` or the plugin list; no `claude mcp add`, no plugin install. Hooks exist only for the session that received `--settings`, so uninstalling means deleting run files. 0010's table gains the first two rows.

### 11. Another adapter

An adapter implements section 1 and declares capabilities (`steer`, `pause`, `resume`, `hooks`, `structuredReport`, `planLimitEvents`, `costEstimate`). The engine hides missing features through 0005 flags: without `steer`, `work.steer` is stored and delivered on resume; without `resume`, every restart is a handoff. Office config picks the adapter per office or role.

- **Agent SDK adapter** (`@anthropic-ai/claude-agent-sdk`) runs inside the worker host and emits the same message types, so `interpret` is shared; `interrupt()`, `setModel` and the `canUseTool` callback replace stdin writes and the permission hook [4][5]. The terms point SDK products at API keys [13], so this adapter would use a Console key and bill real USD. The token budget stays as is; the real USD bill can be checked against the catalog estimate.
- **Non-Claude CLIs** map their own stream to `WorkerEvent` and price through the same catalog. Recordings per adapter (0017) are required before use.

## Consequences

- One parser, used live and on replay, keeps a daemon restart cheap and makes 0017's recordings test the real path.
- The engine owns more: hook relay, caps arithmetic, pricing catalog, plan-limit scheduling and the report schema.
- Workers can never prompt a human by surprise: they ask only when code sees the maintainer present, and otherwise a denied call either finds another way or parks `needs-permission` with the session kept. Denials stay visible as `denied` counts to tune roles.
- Budgets in tokens need no catalog and match what the engine counts; they compare only within one model, which tiers guarantee. The estimated USD in reports still depends on a catalog kept current; the CLI cross-check catches drift.
- Overnight runs share the maintainer's plan limits, and the terms assume ordinary individual use. Plan-limit waits and the `allowed_warning` stop keep the engine from pushing through limits, but heavy unattended use remains a judgement call for the maintainer. Because plan limits always wait, a weekly limit can hold a story for days; it shows as `limited`, not parked.
- Every run depends on `srt` and on the sandbox self-test; on a machine where either fails, nothing runs until it is fixed.
- Before the first M0 adapter story, record live (with 0017): `--json-schema` per turn in streaming input, `priority: "now"` for pause and stop, a session-limit and a model-limit hit in `-p` and how their scope shows, `utilization` units, `apiKeySource` on a claude.ai login, `requires_action` next to the `PermissionRequest` wait, the allow-once hook on a resumed session, and the safety checks of section 2, including the self-test with `gh auth status` and the `srt` policy for install and verify.
- The sandbox may break project scripts that read outside the toolchain list or need a host; the fix is an office-level `allowRead` or `allowedDomains` entry, reviewed like code, never `excludedCommands`.
- M0 stories: contract types and pure parser with recordings; launch plan, probe and the sandbox self-test; `srt` wrapper and policy translator for install and verify; hook relay and `dipo hook` with the presence check and the `needs-permission` flow; token caps and plan-limit scheduling; pricing catalog; resume check.

## Amends

Changes to accepted ADRs, each with a dated line under its "Amendments":

- **0005:** new park reasons `needs-permission` and `worker-failed` (the `ParkReason` list is updated in place); `Usage.budget` unit is `"tokens"`; `UsageTotals.cacheTokens` splits into `cacheCreateTokens` and `cacheReadTokens`, because only cache creation counts against the budget; minor additions `QuestionView.kind` (`question` or `permission`) and `work.answer` `decision: "allow" | "deny"` for permission questions.
- **0001 and 0012:** the same two park reasons (0012's transition row is updated in place).
- **0010:** setup also copies the main checkout's `.claude/settings.local.json` when present; the first env file copy per office shows the development-secrets rule once and lists the files; install runs inside `srt` with the run's policy and refuses when `srt` is unavailable; the field-block park reason list is updated in place.

0011 item 7 left the budget unit to this spike and already names tokens, so it needs no change. 0007 does not exist yet; DIPO-4 stores the budget columns in tokens from the start.

## Open questions for the maintainer

1. **Budget unit — answered 2026-10-10: raw tokens.** The budget counts input, output and cache-creation tokens; cache reads are recorded and shown but do not count, and estimated USD is computed for reports only. The engine enforces it, `--max-budget-usd` is dropped, and tier budgets are token defaults to tune after M0.
2. **Asking the maintainer for permissions — answered 2026-10-10: hybrid, decided by code.** Ask through `question.asked` (kind permission, 300 s) when the maintainer is present, otherwise deny at once; a worker that cannot finish without the action parks `needs-permission`, and the maintainer allows it once for the resumed run or denies it. `permissions.ask: when-present` replaces `askMaintainer`.
3. **Plan limits — answered 2026-10-10: always wait for the reset.** No maximum wait and no park; `allowed_warning` stops new runs on that scope, and without `resetsAt` the engine probes hourly. `credits_required` holds the run and the adapter with a notice until the maintainer resumes.
4. **Claude transcripts — answered 2026-10-10: leave them to Claude Code's 30-day retention.** No purge at teardown.
5. **Crash after one resume — answered 2026-10-10: new park reason `worker-failed`,** showing the last error, distinct from `interrupted`.
6. **Setting sources — answered 2026-10-10: `--setting-sources project,local`.** The engine copies the main checkout's `.claude/settings.local.json` into the worktree at setup, worker writes to `.claude/` settings files are denied, and hooks, `env` or `apiKeyHelper` from either file refuse the run unless allowlisted.
7. **Model fallback — answered 2026-10-10: accept the classifier switch.** It is recorded on the run with an `engine.notice`, and usage is counted per model.
8. **Env files in worktrees — answered 2026-10-10: accept the residual risk** with the rule that worktree env files hold development secrets only. dipo shows the rule once, when it first copies env files, and lists the files copied.
9. **Shared `.git` — answered 2026-10-10: option a.** OS-level deny of all worker writes to `<main>/.git` and the `<worktree>/.git` pointer, hardened engine git, and a fail-closed self-test that also requires `gh auth status` to fail in the sandbox. These limits bind workers only; the engine runs git and `gh` with the maintainer's credentials.
10. **Engine steps on worker-written code — answered 2026-10-10: install and verify run inside `srt`** with the run's policy. Without `srt` the run refuses (fail-closed).

## Sources

1. Claude Code docs, CLI reference (flags, print-mode caps, permission flags, system prompt recording). https://code.claude.com/docs/en/cli-reference
2. Claude Code docs, Run Claude Code programmatically (bare mode, background wait, SIGTERM and SIGINT, exit codes, `api_retry`, `system/init`, permission modes in `-p`, `--permission-prompts none`, resume). https://code.claude.com/docs/en/headless
3. Claude Code docs, Agent SDK: Track cost and usage (dedup by id, placeholder output, `usage` vs `modelUsage`, streaming input totals, crash and budget results, restored totals, estimates). https://code.claude.com/docs/en/agent-sdk/cost-tracking
4. Claude Code docs, Agent SDK TypeScript reference (`SDKMessage` union, result fields and `terminal_reason`, `SDKSystemMessage`, `SDKPermissionDeniedMessage`, `SDKRateLimitEvent`, `SDKSessionStateChangedMessage`, assistant `error`, `tool_progress` heartbeat, `ModelUsage`, `SDKUserMessage`, `interrupt()`, `taskBudget`). https://code.claude.com/docs/en/agent-sdk/typescript
5. Claude Code docs, Agent SDK: Streaming input. https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
6. Claude Code docs, Hooks reference (events, common input, Notification matchers, `PermissionRequest` in non-interactive sessions, `Stop`, `StopFailure`, `SubagentStop`, timeouts, merging). https://code.claude.com/docs/en/hooks
7. Claude Code docs, Settings files and precedence (`--settings` level, lists merge). https://code.claude.com/docs/en/settings
8. Claude Code docs, Configure permissions (deny, ask, allow order; Bash rule limits). https://code.claude.com/docs/en/permissions
9. Claude Code docs, Manage sessions (resume by id, what resume restores, permission mode on `-p` resume, transcript location and retention). https://code.claude.com/docs/en/sessions
10. Claude Code docs, Error reference (usage limit messages, retries, `CLAUDE_CODE_RETRY_WATCHDOG`). https://code.claude.com/docs/en/errors
11. Claude Code docs, Authentication (precedence, `ANTHROPIC_API_KEY` always used in `-p`, bare mode, `claude auth status`). https://code.claude.com/docs/en/authentication
12. Claude Code docs, Model configuration (aliases, effort per model, classifier fallback). https://code.claude.com/docs/en/model-config
13. Claude Code docs, Legal and compliance (OAuth use, Agent SDK and API keys, ordinary individual use). https://code.claude.com/docs/en/legal-and-compliance
14. Claude API docs, Pricing (catalog source; rates not copied here, checked at each catalog update). https://platform.claude.com/docs/en/about-claude/pricing
15. ADRs 0001, 0004, 0005, 0006, 0011, 0015; drafts 0009 (DIPO-6, signal and health names), 0010 (DIPO-7), 0014 (DIPO-10), 0017 (DIPO-14); research ideas 3, 4, 8, 12, 15, 21 in `docs/research/2026-10-comparable-tools.md`.
16. Claude Code docs, Settings reference (`permissions.blockReadsOutsideWorkingDirectories`, `sandbox.*`, `switchModelsOnFlag`). https://code.claude.com/docs/en/settings-reference
17. Claude Code docs, Configure the sandboxed Bash tool (scope, what runs outside, `failIfUnavailable`, `allowUnsandboxedCommands`, admin-required sandbox and v2.1.285 locks, linked worktrees, filesystem and network rules, `strictAllowlist`, `allowLocalBinding`, credentials scopes, protected paths). https://code.claude.com/docs/en/sandboxing
18. Claude Code docs, Environment variables (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`). https://code.claude.com/docs/en/env-vars
19. Claude Code docs, Choose a sandbox environment (Bash sandbox limits for unattended runs; sandbox runtime: wraps any process, `--settings`, network denied by default, `denyWrite` over `allowWrite`, beta). https://code.claude.com/docs/en/sandbox-environments ; package https://github.com/anthropics/sandbox-runtime
20. sandbox-runtime README (beta research preview, Apache-2.0, `srt --settings`, Linux dependencies and the Ubuntu 24.04 AppArmor note, literal paths on Linux, `denyWrite` precedence, empty `allowedDomains` means no network). https://github.com/anthropics/sandbox-runtime
21. npm, `@anthropic-ai/sandbox-runtime` (version to pin). https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime
