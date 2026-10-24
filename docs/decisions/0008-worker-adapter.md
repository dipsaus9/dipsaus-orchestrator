# 0008 The worker and its box

Status: accepted. First written 2026-10-10 (spike DIPO-5). Rewritten 2026-10-24 for the simplified design; it now also holds worker isolation (former 0021). The research behind the rewrite is in `docs/research/2026-10-24-simplification-audit.md`.

## Decision in short

Every developer runs inside its own **box**, a lightweight VM, one per story. The box is the boundary. Inside it the worker may do anything: read the whole repository, run any command, install packages, use the web. It cannot leave the box, it holds nothing of the maintainer's, and its work reaches the repository only as **parts** that dipo checks, commits and pushes. The reviewer and the scan session run on the Mac without a box, with no shell and no write.

The engine reaches every model session through one adapter-neutral contract (section 1). The first adapter wraps the Claude Code CLI on the maintainer's subscription login. Claude names stay inside `engine/src/workers/claude-cli/` (0004).

## 1. The worker contract

An adapter has two halves. The **launch half** runs in the worker host and starts the session. The **interpret half** is a pure parser that the engine runs over the host's event file, so a replay after a daemon restart runs the same code as a live session (0005).

```ts
interface WorkerAdapter {
  id: string;                                    // "claude-cli"
  probe(): Promise<AdapterStatus>;               // version and login kind; refuses below the minimum
  plan(spec: WorkerSpec): LaunchPlan;            // pure: argv, env, files, first stdin lines
  encode(op: SteerOp): HostOp[];                 // pure: steer and stop -> stdin writes and signals
  interpret(line: HostLine, state: ParseState): { events: WorkerEvent[]; state: ParseState };  // pure
  result(state: ParseState, exit: ExitRecord): WorkerResult;                                    // pure
}
WorkerSpec = { run, agent, kind: "implement" | "review" | "session", place: Box | ReadOnlyCopy | None,
               model, effort, caps: Caps, systemFile, taskMessage, tools, sessionId, reportSchema }
Caps = { budgetTokens: number, maxTurns: number, maxMinutes: number }   // loops and rounds stay in the engine
SteerOp = { kind: "message", text } | { kind: "stop" | "kill" }
WorkerEvent = started | activity | output | usage | turn | limit | compacted | modelSwitched | drift
WorkerReport = { status: "done" | "blocked", criteria: { n, met, evidence }[], summary,
                 testPlan: { entry, status, evidence }[], deviations: string[],
                 question?: string, proposals?: Proposal[], decisionNotes?: DecisionNote[], notes?: string }
WorkerResult = { exit: "normal" | "capped" | "plan-limit" | "crashed" | "start-failed" | "stopped",
                 report: WorkerReport | null, usage, sessionId }
```

The adapter reports facts. The engine decides phase, feedback, commits and parks, and maps a result to how the run ends (0020).

## 2. The box

**Technology.** Apple `container`: each box is its own VM with its own kernel. The engine reaches it through one box interface (`engine/src/box/`), so another backend can be added later without changing this design. Every call except the live session has a deadline.

**Contents.**
- A plain copy of the repository at the story's start commit, with no `.git` and no history.
- Files outside git only when the office config lists them in `box.files` and marks each as holding no real secrets.
- Nothing of the maintainer's: no host environment variables, no `~/.npmrc` or other settings files, no Keychain, no SSH agent, no home folder, no mounted host directory.

**Network.**
- Each box joins a host-only network with no route out.
- Its only way out is dipo's **web proxy** on the Mac. The proxy tunnels to public internet addresses only. It refuses the Mac's own addresses, the local network, private, reserved and box-network ranges, and bare IP addresses. It resolves each name once and connects to the checked address, so DNS rebinding has no gap.
- **Package registries are reachable only through Safe-Chain**, which checks packages for malware. The web proxy refuses known registry aliases, CDN names and mirrors, and checks that a TLS handshake names the host it tunnels to. Safe-Chain itself runs in a box.
- The Mac's own ports listed in `box.localPorts` are reached only through the web proxy, by a box dipo admitted.
- **An in-box firewall** allows output only to loopback and to dipo's proxies. dipo sets it before the first install and checks it at every session.
- **Every command dipo starts in a box runs as the box user** (uid 1000, no capabilities, no new privileges), so a worker cannot undo the firewall. Only fixed dipo steps run as root, from an allow list without network capabilities.

**The login.** Claude Code in the box sends model requests to dipo's **model proxy** on the Mac. The proxy passes only the model endpoints and adds the maintainer's subscription login on the way out. The token never enters the box.

**The image and the package cache.**
- The office config describes the image: toolchain, versions and system packages. Stories cannot change it. dipo detects a default from the repository (0013).
- dipo builds the image once in a build box on the same closed network, through the same proxies, and saves it with `container commit`. No package install script runs before the firewall is set.
- Claude Code's version in the image is pinned, with auto-update and nonessential traffic off.
- Each office has one package cache, filled by dipo from the lockfile in a box, through Safe-Chain. Boxes mount it read-only.
- A worker that needs another tool proposes it (section 4, W5), and the maintainer adds it to the office config.

**Lifetime.**
- dipo creates the box at the claim and installs the office's packages in it at the start commit.
- The box lives until the story's PR merges, or until the story is dropped or discarded.
- It runs while a developer session runs, and is stopped, with its files kept, while the story waits (review, CI, an answer, a park, the maintainer).
- A lost box is rebuilt from the start commit plus the delivered parts; only undelivered work is lost, and the maintainer is told.
- There are no CPU, memory or disk limits per box (Apple's 1 GiB default memory limit is raised). The budget caps stop the worker.

**The escape probe.** `tools/box-probe/probe.sh` tries, as root inside a box, to read the home folder, reach the Mac, the local network and a registry directly, switch off the network rules, and find the token or host settings. Each of these must fail, while an install through Safe-Chain and a request to the internet must work. It passed on Apple `container` 1.6.0 on 2026-10-21. Any change to the box's network, user, mounts or image build runs it again, and fails if any line fails (CLAUDE.md, R30).

## 3. What dipo never does

- dipo never runs a tool (git, the Backlog CLI, a package manager, a test) unsandboxed **in, or on configuration from, a folder a worker can write**. Status writes, criteria ticks and commits happen in dipo's own copy of the repository, never in the box.
- dipo never runs a tool inside the box on the Mac's behalf, except its fixed steps (install, the part transfer, the firewall).
- The Backlog CLI refuses to run on files dipo cannot check: front matter that is not plain YAML, a special or oversized file, or a configuration that would run a command.

## 4. The door

The only traffic between a box and dipo is the session's stream-json and these messages. Every message from the worker is size-limited, checked against a strict format, treated as untrusted text, and cleaned of terminal control characters before the maintainer sees it.

| From the worker | dipo does |
|---|---|
| W1 **Part**, with a short message | Takes the part out, scans, commits and pushes it (section 5) |
| W2 **Done**, with the report | Runs the report gate, then the review loop (0002) |
| W3 **Question** | Parks the story with the question (0020) |
| W4 **Blocked**, with a reason | Parks the story `ambiguous-spec` with the reason |
| W5 **Proposal**: a follow-up, a spike or a tool | Stores it for the desk; nothing happens on its own (0020) |
| W6 **Live activity**: tool calls, output, usage | Feeds the caps and the live view |

| To the worker | |
|---|---|
| D1 | The task: story, criteria, context (0014) |
| D2 | A message: feedback of any source, an answer, a steer (0002) |
| D3 | Stop: a cap was reached or the maintainer stopped it |

Inside the box there are no per-call checks, no permission prompts, no hooks and no link to dipo's sockets.

## 5. Delivery in parts

1. On W1, and once more on done, dipo streams the changes since the last delivered part out of the box as one `tar`, into a fresh folder of its own. It never uses `container cp`, which keeps symlinks as links.
2. dipo scans the part:
   - **Protected files:** the story's task file, CI workflows, dipo's configuration, and the configuration of tools dipo runs on checkouts (`backlog.config.yml`, `.backlog/`, `bunfig.toml`, `.mcp.json`).
   - **Secrets:** values from the files in `box.files`, and token formats.

   A hit refuses the part and parks the story `scope-violation`. Such a park is not resumable: the box can no longer be trusted, so the way on is `dipo discard` and a new run.
3. dipo commits the part on the story branch from git objects in its own copy, with the worker's message as text only, and pushes without force.

dipo computes each story's real changed files from its parts. When two stories in progress change the same file, dipo tells the maintainer and both workers, and both continue. Whichever merges second gets a conflict hand-off if git cannot merge it cleanly (0002).

## 6. The Claude CLI adapter

**Probe.** `claude --version` and `claude auth status` on the Mac. The probe refuses below the minimum version or with any login but `claude.ai`, so no run ever bills an API key.

**The developer session**, started by the worker host as a long-running `container exec` as the box user:

```
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
  --session-id <uuid>
  --model <m> --effort <e>                    # from the tier
  --max-turns <tier maxTurns>                 # backstop; the engine enforces the caps
  --permission-mode bypassPermissions          # the box is the boundary
  --append-system-prompt-file <file> --exclude-dynamic-system-prompt-sections
  --json-schema <report schema>
  --disable-slash-commands --strict-mcp-config
```

The task message is the first stdin line, never on argv. The box's environment holds only the route to the proxies and a placeholder key. Every session's `system/init` is checked: `apiKeySource` must be `none`, and the model must match the planned one or a classifier switch recorded on the run.

**The reviewer and the scan session** run on the Mac with no box. The reviewer gets a read tool on a read-only `git archive` copy of the pushed head and web search, and nothing else: no shell, no write, no `gh`. Its web calls pass a `PreToolUse` hook, `dipo hook PreToolUse --gate`, which refuses a URL or query that contains a value from `box.files`. The hook decides in its own process from a file of those values that the launch plan writes outside the copy, and it fails closed. The scan session has every tool off. Neither session loads settings, hooks, plugins or skills from the repository copy. These are the only hooks dipo registers.

**Steering and stop.**
- Every op the engine sends is first stored as an intent on the run, so the result is read from the intent and never guessed from the exit.
- A message is one user message with priority `next`, so it lands once the running tool calls finish.
- A stop is a `now` message, then stdin closes, then SIGTERM after 10 s and SIGKILL after 30 s.

**How a session ends:**

| Observed | dipo does |
|---|---|
| Report `done` | The report gate and the review loop (0002). A done report on the turn that crosses a cap is honoured |
| Report `blocked` with a question or a reason | Parks `ambiguous-spec` (0020) |
| A cap reached (tokens, turns, minutes, the CLI's turn backstop) | Parks `budget-exceeded`, naming the cap |
| No valid report, after one correction turn | Parks `worker-failed` |
| A crash while the daemon watches the session | One fresh session with a handoff, then `worker-failed` |
| A host found dead or not answering at recovery | Parks `worker-failed` (0005) |
| 10 stream lines that fail their schema, or usage that cannot be read | Parks `worker-failed` ("stream drift"), naming the Claude Code version |
| `rate_limit_event` `rejected` | Parks `worker-failed` ("plan limit until T"). The office's starts paused holds until T and then resumes it (0020) |
| Login, billing, start-up or box token failure | The office's starts paused, with a notice. The story stays where it was |
| `apiKeySource` not `none` | Stops the session and pauses starts in every office |

**Resume.** Every session starts with an engine-made session id. A developer resume is always a new session in the story's box with a handoff (0014). The reviewer is never resumed.

## 7. Usage and cost

- Per run, agent and model, dipo stores input, output, cache creation and cache read tokens, turns and durations. Live numbers come from assistant messages deduplicated by message id, and the turn's result replaces them.
- **The budget is tokens:** input plus output plus cache creation. Cache reads are shown but do not count. Each tier has a fixed model, so a tier's tokens always mean the same thing.
- **Cost is the cost the CLI reports** (`total_cost_usd`, `costUSD`). dipo stores it as reported and keeps no price catalog of its own (0007). The views show it; budgets and spend alerts count tokens (0009).

## 8. Tiers to caps

| Tier | Model | Effort | Budget tokens | Turns | Minutes | Loops |
|---|---|---|---|---|---|---|
| S | haiku | low | 300,000 | 90 | 45 | 3 |
| M | sonnet | medium | 800,000 | 200 | 90 | 5 |
| L | opus | high | 2,000,000 | 300 | 180 | 8 |

The reviewer has its own caps: model opus, effort high, 60 turns, 30 minutes and 200,000 tokens per session (0002). The engine checks the totals after every usage and turn event and stops the session at 100% of a cap. Each feedback message carries a budget line, and at about 80% of a cap the worker wraps up (0014).

## 9. Another adapter

An adapter implements section 1. An Agent SDK adapter would share `interpret`, because it emits the same message types, but Anthropic's terms point SDK products at API keys, so it would bill real money. A non-Claude CLI maps its own stream to `WorkerEvent`. Every adapter needs recordings before use (0017).

## Replaced

- Claude Code's Bash sandbox with permission rules, deny lists, a `PermissionRequest` relay, allow-once answers, a Bash `PreToolUse` hook with `gh` and temp guards, Keychain denies, a launch self-test and the project-settings allowlist (2026-10-10 to 2026-10-20). Replaced by the box (2026-10-21), because only Bash was sandboxed and the rest ran on the Mac.
- `srt` around engine install and verify steps, and later around Safe-Chain (2026-10-12). Replaced by the box (2026-10-22), and Safe-Chain in a box (2026-10-24).
- Verify run by dipo in the box at done (2026-10-21). Replaced by CI as the verify (2026-10-22), because the box has no git and many test suites need it.
- `bypassPermissions` ruled out as "no guard at all" (2026-10-10). Inside a box it is the documented pattern, and the box is the guard (2026-10-21).
- A pricing catalog with versioned rates and a drift check against the CLI (2026-10-10). Replaced by the CLI's reported cost (2026-10-24).
- Native `--resume` chosen by a cost check, and transcript tailing for usage after a crash (2026-10-10, 2026-10-18). Replaced by a new session with a handoff in the kept box, and the usage the stream showed (2026-10-24).
- Pause, reassign and nudges as steer ops. Pause and reassign are gone (0020); nudges went with the developer's hooks.
- `needs-permission` and `scopeRequest` in the report. A box worker has every permission, and references are a forecast (2026-10-21).
- Plan-limit waits that held a run In Progress for days, and adapter holds per launch kind. Replaced by the office's starts paused (0020, 2026-10-24).
- A web gate that asked the engine over the host socket. Replaced by a gate that decides in its own process (2026-10-24).
