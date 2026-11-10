# 0008 The worker and its box

Status: accepted. First written 2026-10-10 (spike DIPO-5). Rewritten 2026-10-24 for the simplified design; it now also holds worker isolation (former 0021). The research behind the rewrite is in `docs/research/2026-10-24-simplification-audit.md`.

## Decision in short

Every developer runs inside its own **box**, a lightweight VM, one per story. The box is the boundary. Inside it the worker may do anything: read the whole repository, run any command, install packages, use the web. It cannot leave the box, it holds nothing of the maintainer's, and its work reaches the repository only as **parts** that dipo checks, commits and pushes. The reviewer runs in a read-only box of its own, and so does the maintainer's planning session. The scan session runs on the Mac with every tool off.

The engine reaches every model session through one adapter-neutral contract (section 1). The first adapter wraps the Claude Code CLI on the maintainer's subscription login. Its code lives in `engine/src/workers/claude-cli/`; where else Claude may be named is in 0001.

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
WorkerSpec = { run, agent, kind: "implement" | "review" | "session" | "planning", place: Box | ReadOnlyCopy | None,
               model, effort, caps: Caps, systemFile, taskMessage, web, sessionId, reportSchema }
Caps = { budgetTokens: number, maxTurns: number, maxMinutes: number }   // loops and rounds stay in the engine
SteerOp = { kind: "message", text } | { kind: "stop" | "kill" }
WorkerEvent = started | activity | output | usage | turn | limit | compacted | modelSwitched | drift
WorkerReport = { status: "done" | "blocked", criteria: { n, met, evidence }[], summary, commitSubject,
                 testPlan: { entry, status, evidence }[], deviations: string[],
                 question?: string, proposals?: Proposal[], decisionNotes?: DecisionNote[], notes?: string }
WorkerResult = { exit: "normal" | "capped" | "plan-limit" | "crashed" | "start-failed" | "stopped",
                 report: WorkerReport | null, usage, sessionId }
```

The adapter reports facts. The engine decides phase, feedback, commits and parks, and maps a result to how the run ends (0020).

The engine names no tools. The adapter names each kind's tools: the developer's, plus web search and fetch when `web` is on; the reviewer's read and web tools; the same read and web tools for a planning session; none for a session. `web` is the developer's switch: the adapter refuses it on a review, planning or session spec, and refuses a kind it names no tools for. A planning spec that carries a tool, MCP or permission field is refused; the other kinds ignore one. The plan of a read-only kind is checked once built: one `--tools` with only the kind's own names, compared exactly, so another case, a rule, an alias or an MCP tool fails; no flag that adds tools, permissions, settings, plugins or MCP servers; and `--strict-mcp-config`. A planning session whose `system/init` lists any other tool is stopped there.

## 2. The box

**Technology.** Apple `container`: each box is its own VM with its own kernel. The engine reaches it through one box interface (`engine/src/box/`), so another backend can be added later without changing this design. Every call except the live session has a deadline.

**Contents.**
- A copy of the repository at the story's start commit, with **its own local git repository**: dipo runs `git init` in the copy and commits the start state, so tests and tools that need git work. It shares nothing with your repository: no refs, no config, no hooks, no history before the start commit, and the Mac never runs git in it. When dipo copies a merge dipo made outside the box (of the base, or of the remote branch after a rejected push) into the box (0002), a fixed dipo script commits the merged files in this repository as a commit of their own, so the worker's git log shows that merge's changes and its git diff only its own work.
- Files outside git only when the office config lists them in `box.files` and marks each as holding no real secrets.
- Nothing of the maintainer's: no host environment variables, no `~/.npmrc` or other settings files, no Keychain, no SSH agent, no home folder, no mounted host directory.

**Network.**
- Each box joins a host-only network with no route out.
- Its only way out is dipo's **web proxy** on the Mac. The proxy tunnels to public internet addresses only. It refuses the Mac's own addresses, the local network, private, reserved and box-network ranges, and bare IP addresses. It resolves each name once and connects to the checked address, so DNS rebinding has no gap.
- **Package registries are reachable only through Safe-Chain**, which checks packages for malware. The web proxy refuses known registry aliases, CDN names and mirrors, and checks that a TLS handshake names the host it tunnels to. Safe-Chain itself runs in a box of its own, made from one machine-wide Safe-Chain image: Debian's slim image, the box network tools and the official Safe-Chain release binary pinned by sha256, with no package install, so building it needs no Safe-Chain. Only dipo's web proxy reaches that box, and its own traffic leaves only through dipo's proxy to the registries and Safe-Chain's malware lists. It lives as long as dipo's web route; one a stopped daemon left is deleted at the next start of a daemon with the same state folder, which every box dipo makes names in a label.
- The Mac's own ports listed in `box.localPorts` are reached only through the web proxy, by a box dipo admitted.
- **An in-box firewall** allows output only to loopback and to dipo's proxies. dipo sets it before the first install and checks it at every session. A test box's firewall (below) also answers connections that the Mac's address on the box network opened to its dev port, and lets nothing else in.
- **Every command dipo starts in a box runs as the box user** (uid 1000, no capabilities, no new privileges), so a worker cannot undo the firewall. Only fixed dipo steps run as root, from an allow list without network capabilities.
- **Every box starts with Apple container's init as PID 1**, which adds one read-only file mount, `/.cz-init`, from the VM's root; the keepalive runs as its child, and the init reaps orphaned processes.

**The login.** Claude Code in the box sends model requests to dipo's **model proxy** on the Mac. The proxy passes only the model endpoints and adds the maintainer's subscription login on the way out. The token never enters the box.

**The count.** Every program in a box may call the model through the proxy: Claude Code, a product's tests using the Anthropic SDK, or `curl`. The proxy counts all of it against the run of the box that sent it:
- It knows the sender only by its peer address. `BoxWorkers` records each box's address with its session's run and agent when the session starts, and drops it when the box stops. A run named in a header or the body is ignored.
- A request from an address no running session owns is refused and never forwarded. So is one whose run's usage cannot be recorded: before it forwards any request, the proxy writes the run's usage row, and a failed write refuses the request. After a failed write, no request of that office goes on until a write succeeds.
- Once the run's token cap is reached (a reviewer's own cap for a reviewer), the proxy refuses new requests with 429, so a program that is not Claude Code cannot run past the cap while the engine stops the session. A session run with no token budget (a planning session's or an idea audit's, recorded with budget limit 0) is counted the same way, against that run: its requests count in the office's usage and spend and are never refused for a cap.
- It reads the `usage` of each answer it passes and adds it as the upstream sends it: the JSON body; or a stream's `message_start` usage (input and cache at once) and each later `message_delta` usage over it. It reads a stream from the upstream at the upstream's pace, whether or not the box reads it, so a stream held open unread still counts what was spent. A stream cut off counts what arrived. A `count_tokens` request is forwarded and adds nothing.
- It adds input, output, cache creation and cache read tokens to the run's records, which the caps, the tier budget and the spend alerts read (section 7).
- A count is lost for a request in flight when its office unloads, and for the rest of a stream a daemon restart cuts. After a restart, a box that is still running gets 403 until its next session starts, because the registry lives in the daemon.

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

**The test box** (0002). Each `dipo test` makes a new box from the story branch's pushed head, like a developer's box: the office image, its own local git repository, only the listed `box.files`, the office's install through Safe-Chain, then `setup` and `dev`. The builder's box is not touched. The Mac reaches `dev` through a forwarder that dipo runs on the Mac: it listens on 127.0.0.1 and connects to the dev port at the test box's address from the Mac's address on the box network, so it works while a VPN routes the box network's range. When `dev` listens only on the box's loopback, a socat relay in the box passes the box's address to it. No port is published. The box is deleted when the test is recorded or closed. A test box that a stopped daemon left goes at the next start of a daemon with the same state folder, unless an open test of an office registered there names it; no other daemon's start deletes it.

**The escape probe.** `tools/box-probe/probe.sh` tries, as root inside a developer box and inside the Safe-Chain box, to read the home folder, reach the Mac, the local network and a registry directly, and find the token or host settings. Each of these must fail, while an install through Safe-Chain and a request to the internet must work. Switching off the network rules as root must not open the internet, the local network or the registries. The Mac's own address then relies on workers running as the box user with no capabilities (the accepted risk of 2026-10-21, `tools/box-probe/RESULTS.md`). It passed on Apple `container` 1.6.0 on 2026-10-21, with the Safe-Chain box on 2026-10-27, and for a test box on 2026-10-28. Any change to the box's network, user, mounts or image build runs it again, and fails if any line fails (CLAUDE.md, R30).

## 3. What dipo never does

- dipo never runs a tool (git, the Backlog CLI, a package manager, a test) unsandboxed **in, or on configuration from, a folder a worker can write**. Status writes, criteria ticks and commits happen in dipo's own copy of the repository, never in the box.
- dipo runs nothing inside the box except its fixed steps (install, the part transfer, the firewall) and the office's verify at done (0002), which runs as the box user.
- The Backlog CLI refuses to run on files dipo cannot check: front matter that is not plain YAML, a special or oversized file, or a configuration that would run a command.

## 4. The door

The only traffic between a box and dipo is the session's stream-json and these messages. Every message from the worker is size-limited, checked against a strict format, treated as untrusted text, and cleaned of terminal control characters before the maintainer sees it.

| From the worker | dipo does |
|---|---|
| W1 **Part**, with a short message | Takes the part out, scans, commits and pushes it (section 5) |
| W2 **Done**, with the report | Runs the report gate and the verify in the box, then the review loop (0002) |
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

1. On W1, and once more on done, dipo streams the changes since the last delivered part out of the box as one `tar`, leaving the box's `.git` out, into a fresh folder of its own. It never uses `container cp`, which keeps symlinks as links.
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
  --replay-user-messages                      # each user message is echoed as it is read
  --session-id <uuid>
  --model <m> --effort <e>                    # from the tier
  --max-turns <tier maxTurns>                 # backstop; the engine enforces the caps
  --permission-mode bypassPermissions          # the box is the boundary
  --append-system-prompt-file <file> --exclude-dynamic-system-prompt-sections
  --json-schema <report schema>
  --disable-slash-commands --strict-mcp-config
```

The task message is the first stdin line, never on argv. The box's environment holds only the route to the proxies and a placeholder key. Every session's `system/init` is checked: `apiKeySource` must be `none`, and the model must match the planned one or a classifier switch recorded on the run.

**The reviewer** runs in a read-only box of its own, made for each review session from the office image: a `git archive` copy of the pushed head, no `box.files`, and the same firewall, box user and proxies as a developer box. Its tools are read, glob, grep, web search and web fetch: no shell, no write, no `gh`. The box is deleted when the session ends. **The planning session** is the maintainer's: at most one per office, started with a kind (`plan`, `refine` or `triage`) and a goal, and talked to turn by turn until the maintainer ends it. It runs in a read-only box made as a reviewer's, with a copy of the base branch's tip, which holds the backlog, and the reviewer's tools. Its plan passes no structured-output schema: each turn ends in a text answer. Its first message is the kind and goal with the facts code knows, as text: the open drafts, the desk and the recent story runs. Each maintainer message is one user message on its stdin, its next turn. It is a session run with no story: its answers and spend go out as planning events, not work events, and it holds no run slot (0002). It has no token or minute cap; between turns the watchdog's quiet and stuck waits stop, and a session that waits `planning.idleHours` (a day) for a message ends by itself. Its box is deleted when it ends, and at daemon stop. **The scan session** runs on the Mac with every tool off, and so without Claude Code's Bash sandbox: with no tool there is no shell to guard. None of these sessions loads settings, hooks, plugins or skills from the repository copy. No session has hooks, so dipo registers none and `dipo hook` goes.

**Steering and stop.**
- Every op the engine sends is first stored as an intent on the run, so the result is read from the intent and never guessed from the exit.
- A message is one user message with priority `next`, so it lands once the running tool calls finish. One that comes after the turn's last tool call is read only after the turn's result, and starts a new turn.
- The session echoes each user message as it reads it, which marks a steer read. A done report while a steer is unread waits for the turn that steer starts, whose report decides. A steer still unread when its session ends goes with the run's next developer session's first message.
- A stop is a `now` message, then stdin closes, then SIGTERM after 10 s and SIGKILL after 30 s.

**How a session ends:**

| Observed | dipo does |
|---|---|
| Report `done` | The report gate and the review loop (0002). A done report on the turn that crosses a cap is honoured |
| Report `blocked` with a question or a reason | Parks `ambiguous-spec` (0020) |
| A cap reached (tokens, turns, minutes, the CLI's turn backstop) | Parks `budget-exceeded`, naming the cap, and says first when the run handed no part |
| A report that does not parse or does not match the schema, after one correction turn | Parks `worker-failed`; only a question or a blocked report parks `ambiguous-spec` |
| A crash while the daemon watches the session | One fresh session with a handoff, then `worker-failed` |
| A host found dead or not answering at recovery | Parks `worker-failed` (0005) |
| 10 stream lines that fail their schema, or usage that cannot be read | Parks `worker-failed` ("stream drift"), naming the Claude Code version |
| `rate_limit_event` `rejected` | Parks `worker-failed` ("plan limit until T"). The office's starts paused holds until T and then resumes it (0020) |
| Login, billing, start-up or box token failure | The office's starts paused, with a notice. The story stays where it was |
| `apiKeySource` not `none` | Stops the session and pauses starts in every office |

**The worker host's launch deadline.** A daemon claims a worker host with a `claim` on the host's socket, sent only once the daemon holds the host's verified PID in its `worker_hosts` row and follows its run; a handshake alone claims nothing. Every host must be claimed by its launch deadline, `HOST_LAUNCH_DEADLINE_MS` (30 s) after its row was written, which `launch.json` carries. That is the one rule: a host no daemon claimed by then stops its worker as on SIGTERM and refuses a later handshake or claim. So a host the daemon cannot verify, a host whose run ended while it was asked, and a host whose daemon stopped before recording it are never claimed, and stop themselves. Until the deadline the daemon that started the host keeps connecting, and a restarted daemon keeps a pending row and asks its socket again, so a host that binds its socket late is still re-attached. At the deadline a pending row no verified host answered for goes, and its story parks `worker-failed`; a pending row is never claimed, so none goes while its host runs claimed. dipo never signals a pending host, whose PID is known only from its own handshake.

**Resume.** Every session starts with an engine-made session id. A developer resume is always a new session in the story's box with a handoff (0014). The reviewer and the planning session are never resumed: a planning session a daemon stop ended stays ended.

## 7. Usage and cost

- Per run, agent and model, dipo stores input, output, cache creation and cache read tokens, turns and durations.
- **The caps read the proxy's count.** For a session in a box, the model proxy's count is the token total (section 2). Its stream's usage events add no tokens: a turn's result adds its turns and keeps the cost the CLI reports, so a Claude Code turn is counted once. The caps see the proxy's count at the next usage or turn event of the stream, or at the minute tick. The proxy counts an answer before its turn's result reaches the stream. So a token crossing found at the minute tick, or at a usage event with no done turn after it in the same pass, waits one more pass or tick: a done report in that window is honoured, as on the crossing turn (section 6); otherwise the cap fires.
- The scan session runs on the Mac without the proxy, so its stream counts its tokens: live numbers from assistant messages deduplicated by message id, replaced by the turn's result.
- **The budget is tokens:** input plus output plus cache creation. Cache reads are shown but do not count. Each tier has a fixed model, so a tier's tokens always mean the same thing.
- **Cost is the cost the CLI reports** (`total_cost_usd`, `costUSD`). dipo stores it as reported and keeps no price catalog of its own (0007). The views show it; budgets and spend alerts count tokens (0009).

## 8. Tiers to caps

| Tier | Model | Effort | Budget tokens | Turns | Minutes | Loops |
|---|---|---|---|---|---|---|
| S | haiku | low | 300,000 | 90 | 45 | 3 |
| M | sonnet | medium | 800,000 | 200 | 90 | 5 |
| L | opus | high | 2,000,000 | 300 | 180 | 8 |

The reviewer has its own caps: model opus, effort high, 60 turns, 30 minutes and 200,000 tokens per session (0002). The planning session has model opus and effort high by default (`planning.model`, `planning.effort`), 100 turns per answer and no token or minute cap. The engine checks the totals after every usage and turn event and stops the session at 100% of a cap. Each feedback message carries a budget line, and at about 80% of a cap the worker wraps up (0014).

## 9. Another adapter

An adapter implements section 1. An Agent SDK adapter would share `interpret`, because it emits the same message types, but Anthropic's terms point SDK products at API keys, so it would bill real money. A non-Claude CLI maps its own stream to `WorkerEvent`. Every adapter needs recordings before use (0017).

## Replaced

- Claude Code's Bash sandbox with permission rules, deny lists, a `PermissionRequest` relay, allow-once answers, a Bash `PreToolUse` hook with `gh` and temp guards, Keychain denies, a launch self-test and the project-settings allowlist (2026-10-10 to 2026-10-20). Replaced by the box (2026-10-21), because only Bash was sandboxed and the rest ran on the Mac.
- `srt` around engine install and verify steps, and later around Safe-Chain (2026-10-12). Replaced by the box (2026-10-22), and Safe-Chain in a box (2026-10-24).
- A pass for a host of an earlier binary with no launch deadline, which took no claim, and the stop of an earlier binary's developer session on the Mac at re-attach (2026-10-23, 2026-10-30). Gone with the database squash (0007, 2026-11-03).
- The same Bash sandbox, with Keychain and credential denies, kept for the scan session on the Mac (2026-10-23). Removed (2026-11-03): every tool of that session is off, so it guarded a shell the session cannot use.
- Switching off the network rules as root must fail for every target (2026-10-24). Replaced by: it must not open the internet, the local network or the registries (2026-10-28), because root in a box keeps the capability its firewall needs.
- Safe-Chain box from the office image (2026-10-24). Replaced by one machine-wide Safe-Chain image (2026-10-27), because building an office image needs Safe-Chain.
- Verify run by dipo in the box at done (2026-10-21), replaced by CI as the only verify (2026-10-22) because the box had no git and many test suites need it. Reinstated (2026-10-24) once the box got its own local git repository, with the required checks last (0002).
- `bypassPermissions` ruled out as "no guard at all" (2026-10-10). Inside a box it is the documented pattern, and the box is the guard (2026-10-21).
- A pricing catalog with versioned rates and a drift check against the CLI (2026-10-10). Replaced by the CLI's reported cost (2026-10-24).
- Any daemon start deleted a helper box a stopped daemon left (2026-10-24). Replaced by a daemon with the same state folder only, named in each box's label (2026-10-30, DIPO-374), because a test's and a daemon's sweeps deleted each other's boxes.
- Native `--resume` chosen by a cost check, and transcript tailing for usage after a crash (2026-10-10, 2026-10-18). Replaced by a new session with a handoff in the kept box, and the usage the stream showed (2026-10-24).
- Pause, reassign and nudges as steer ops. Pause and reassign are gone (0020); nudges went with the developer's hooks.
- `needs-permission` and `scopeRequest` in the report. A box worker has every permission, and references are a forecast (2026-10-21).
- Plan-limit waits that held a run In Progress for days, and adapter holds per launch kind. Replaced by the office's starts paused (0020, 2026-10-24).
- No git in the box at all (2026-10-21). Replaced by a box-local repository that shares nothing with yours (2026-10-24), because many test suites need git.
- A box repository that got dipo's merges of the base in its files only, so the worker's git diff showed the base's changes as its own (2026-10-24). Replaced by a commit of each merge dipo copies in, in the box's repository (2026-11-08, DIPO-464).
- A test box reached through a forwarder inside it on the box's address (2026-10-22). Replaced by a forwarder on the Mac's loopback (2026-10-28), because a VPN on the Mac routes the box network's range away from the box bridge.
- The reviewer on the Mac with a `PreToolUse` web-gate hook and its relay through the worker host (2026-10-17). Replaced by a read-only reviewer box (2026-10-24); no session has hooks.
- `WorkerSpec.tools`, the tool names of each role picked by the engine (2026-10-10). Replaced by `web`: the adapter names each kind's tools, so Claude's tool names stay in it (2026-10-29).
- The keepalive as the box's PID 1 (2026-10-22), which never reaped orphans, so zombies piled up in a long-lived box. Replaced by Apple container's init as PID 1 with the keepalive as its child (2026-10-30, DIPO-378).
- Caps that counted only the usage of Claude Code's own stream (2026-10-10), so a product's tests or `curl` in a box spent the subscription unseen. Replaced by the model proxy's count of every request a box makes, by the sender's address (2026-11-02, DIPO-425).
