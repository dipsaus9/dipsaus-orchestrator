# Comparable tools (research, October 2026)

Research done 2026-10-09 and 2026-10-10 by research agents reading the public repositories through the GitHub API. No code from these tools was run or installed. Claims are tied to file paths in each repository; items marked **[unverified]** could not be confirmed. Decision: [0015](../decisions/0015-build-own-inspired-not-dependent.md), build our own, inspiration not imitation.

How to read this document: section 1 describes each tool, section 2 compares their model with ours, sections 3 to 6 list what we take, what we avoid, what a future GUI can learn, and which context and token optimizations are relevant. Every adopted idea names the spike or milestone that owns it.

## 1. The tools

### agent-orchestrator

- **Repository:** [OrchestratorInc/agent-orchestrator](https://github.com/OrchestratorInc/agent-orchestrator) (the original `Untrivial-ai/agent-orchestrator` URL redirects here). Apache-2.0.
- **Maturity (2026-10-10):** about 13k stars, 1.8k forks, 100+ contributors, 448 open issues, 362 open PRs. v0.13.6 released 2026-10-09, nightly builds, daily commits. Pre-1.0.
- **What it is:** a local desktop workspace (Electron and React) on top of a Go daemon that runs many coding-agent sessions in parallel, from planning to merge.
- **Concepts:** a *worker* is one task, one agent, one worktree. An *orchestrator* is a persistent LLM session per project that plans and spawns workers through its CLI. A *reviewer* is a separate agent run on a worker's PR. The kanban columns (Working, Needs you, In review, Ready to merge) are derived from facts.
- **Architecture:** Go daemon on 127.0.0.1 with REST, server-sent events (`/api/v1/events`, replay with Last-Event-ID) and a WebSocket terminal multiplexer. Clients: desktop app, mobile app over an authenticated LAN listener, and a CLI. SQLite with trigger-based change capture into a change log that feeds the event stream; only facts are stored and display status is computed when read (`docs/architecture.md`).
- **Agents:** about 30 adapters (`backend/internal/adapters/agent/*`). Claude Code runs as its interactive TUI inside a PTY with model, effort and permission-mode flags; worktree-local hooks report activity (`claudecode/claudecode.go`). A chat mode uses detached per-session hosts that survive daemon restarts.
- **Isolation:** one git worktree per session; per-project `postCreate`, `symlinks` and `env` (`frontend/src/docs/content/guides/parallel-issues.mdx`, `configuration/projects.mdx`).
- **Feedback loop:** CI failures, review comments and merge conflicts are sent back to the owning session automatically, deduplicated by signature (`configuration/lifecycle-automation.mdx`). Merging is always explicit.
- **Cost:** tokens and estimated cost per session and model, parsed from agent transcripts with a file watcher (`observe/usage/watcher.go`) and priced from a versioned catalog (`pricing/catalog/v1`). No budgets or caps.
- **Task source:** free prompts, the LLM orchestrator, or GitHub/GitLab issue intake that starts one worker per issue (`observe/trackerintake/observer.go`). No backlog of its own and no readiness gate.

### agenttrail

- **Repository:** [sodiumsun/agenttrail](https://github.com/sodiumsun/agenttrail). MIT.
- **Maturity:** about 800 stars, one author, created 2026-08-21, last push 2026-09-09. No GitHub releases; npm `agenttrail@0.2.0` and an experimental `agenttrail-kitchen`. Open issue #1: recursive file watching exhausts inotify and crashes the daemon.
- **What it is:** local, read-only observability for coding agents (Claude Code, Codex, Cursor). It does not run agents or decide when work is done.
- **Two views:** *Map* parses a `PLAN.md` convention (components with ids, status markers, `needs:` dependencies, `files:` globs, owners) and shows it next to file activity. *Kitchen* is a 3D view where roles are chefs and the agent's own todo items are dishes.
- **Capture:** a hook relay installed additively in `.claude/settings.local.json` for 11 events, incremental tailing of Claude and Codex transcript files (`packages/kitchen/src/connectors/logs.mjs`), and file watching. It records session start and end, the current and recent tools, todo lists, subagents, permission waits, files touched mapped to components, and inferred handoffs. It excludes prompts and command bodies from what it sends to the browser (`docs/OBSERVABILITY.md`).
- **Evidence model:** every fact is labelled as reported, observed, inferred or unknown.
- **Cost:** none; explicitly out of scope.

### hermes3d

- **Repository:** [iamlukethedev/hermes3d](https://github.com/iamlukethedev/hermes3d). MIT.
- **Maturity:** about 517 stars, one maintainer, v1.0.0 on 2026-08-20, last commit 2026-08-29, open community PRs and an open bug where the demo gateway hangs.
- **What it is:** a self-hosted web frontend showing agents of the Hermes agent backend as characters in a 3D (or 2D pixel-art) office, with chat, approvals, standups, PR review, kanban, analytics and QA screens (`src/features/office/screens/*`).
- **Architecture:** Next.js, React, Three.js with React Three Fiber, Phaser for 2D, and a Node WebSocket proxy (`server/gateway-proxy.js`). The backend owns all agent state; the UI only stores settings. State arrives as an event stream behind a `RuntimeProvider` interface with capability flags (`src/lib/runtime/types.ts`). The office animation is a pure function of events with short-lived latches (`src/lib/office/eventTriggers.ts`).
- **Cost:** per-session tokens and cost by model and agent, with soft budgets per day, month and agent and an alert threshold (`useUsageAnalytics.ts`, `src/lib/studio/settings.ts`). Agent states: idle, working, waiting, blocked, overloaded, error (`docs/agent-state-model-spec.md`).
- **Control:** mainly chat; room moves are triggered by keywords in chat text (`src/lib/office/deskDirectives.ts`).

## 2. Their model compared with ours

| | agent-orchestrator | agenttrail | hermes3d | dipsaus-orchestrator |
|---|---|---|---|---|
| Runs agents | Yes | No, observes | No, visualises | Yes |
| Who decides what runs | An LLM orchestrator session | Not applicable | The Hermes backend | Code, over a gated backlog |
| Where work comes from | Prompts or issues | Its `PLAN.md` | Chat | Backlog.md stories that pass the Ready gate |
| Preparation before work | None | None | None | Refine, unknowns resolved, tier, test script |
| Cost | Measured, no cap | None | Measured, soft alerts | Budget per tier, enforced, park on overrun |
| Roles | Fixed (worker, orchestrator, reviewer) | Inferred from file globs | Agents as characters | Hired, versioned files in the repository |
| Assumed situation | User watching | User watching | User watching | Unattended by design, triage list in the morning |
| First client | Desktop GUI | Browser | Browser 3D | TUI |

**Our differentiator:** prepare first, code decides, budgets enforced, unattended by design, roles in the repository. None of the three does this. agent-orchestrator proves there is demand for a local daemon that runs coding agents in parallel; our bet is that preparation and code-driven gates make that cheaper and more reliable.

## 3. Ideas we adopt

Restated in our own terms. Each has an owner where it becomes an acceptance criterion.

| # | Idea | Inspired by | Owner |
|---|---|---|---|
| 1 | **Facts stored, status derived.** The database stores only facts; every displayed status is computed when read. A change log feeds the event stream, and a client that reconnects replays what it missed. | agent-orchestrator (change capture, event replay), hermes3d (UI as a function of events) | DIPO-2, DIPO-4 |
| 2 | **Evidence labels.** Every value in the overview is labelled reported, observed, inferred or unknown. The overview never invents progress. | agenttrail | DIPO-6 |
| 3 | **Claude telemetry from hooks and transcripts.** Hooks give live state; a permission or input wait means "needs you" and is an early park signal. Transcript tailing gives token usage per session and subagent. Because we start the worker, we bind session to story with certainty instead of guessing. | agenttrail, agent-orchestrator | DIPO-5 |
| 4 | **Estimated cost from a pricing catalog.** Token usage priced from a versioned catalog, so usage can be shown as an estimated cost next to plan-limit usage. | agent-orchestrator | DIPO-4, DIPO-5 |
| 5 | **Mechanical feedback loop.** CI failures, review findings and merge conflicts are routed back to the story's worker by code, deduplicated by signature, within the story's loop and budget caps. | agent-orchestrator | M1 |
| 6 | **Spend alerts across stories.** Daily and monthly usage thresholds with an alert level, on top of per-story tier budgets, because plan limits are shared across all offices. | hermes3d | M1 |
| 7 | **Worktree setup contract.** Per office: steps after creating a worktree, files to link or copy (for example gitignored env files), and environment overrides such as a port offset. | agent-orchestrator | DIPO-7 |
| 8 | **Sessions survive the daemon.** A worker keeps running when the daemon restarts, and a native agent session can be resumed instead of starting over. | agent-orchestrator | DIPO-3, DIPO-5 |
| 9 | **Health states.** A small fixed set (for example working, waiting, blocked, stalled, error) derived from facts and timeouts, used in the overview and the triage list. | hermes3d, agenttrail | DIPO-6 |
| 10 | **Capability flags for clients.** Clients discover what the engine supports through a small read surface and feature flags, so older or third-party clients degrade safely. | hermes3d | DIPO-2 |
| 11 | **Privacy by default in telemetry.** Store what is needed for state and cost, not prompts or command bodies, unless the maintainer opts in. | agenttrail | DIPO-4 |
| 12 | **Reversible, additive setup.** Anything the orchestrator installs into a repository or agent config (such as hooks) is additive and can be removed cleanly. | agenttrail | DIPO-5, DIPO-7 |

## 4. Ideas we avoid

| Idea | Seen in | Why we avoid it |
|---|---|---|
| An LLM session that decides what to spawn | agent-orchestrator | Non-deterministic, costs tokens, bypasses the Ready gate. Code selects work. |
| Steering agents through keywords in chat text | hermes3d | Not deterministic. Our conversation layer may only issue existing commands, with confirmation. |
| Inferring roles or handoffs from timing or file overlap | agenttrail | Their own documentation says it proves nothing. Our engine knows the assignment. |
| One process per repository, port probing and recursive file watching | agenttrail | Crashes (inotify exhaustion), port races. One daemon; use git and worktree state instead of watching every file. |
| Breadth before depth (30 agent adapters, mobile, cloud, several UI modes) | agent-orchestrator | Huge surface and churn. One adapter until the engine is solid. |
| Metaphor over information (3D rooms, decoration) | hermes3d | Expensive and low in information. For us "office" means structure: roster, board, triage. |
| Project configuration only in a local database | agent-orchestrator | Roles and office rules belong in the repository so they are versioned. The database holds machine state. |

## 5. Inspiration for a future GUI

The TUI comes first (decision 0001). A web or desktop GUI is likely later and is a client of the same commands and events. Patterns worth studying then:

- **Board derived from facts** with a "Needs you" column (agent-orchestrator). For us the columns follow the story lifecycle plus Parked, and "Needs you" collects parked stories, open test requests and agents waiting for input.
- **Session detail with terminal attach** (agent-orchestrator WebSocket terminal multiplexer). Lets the maintainer look at or step into a running worker.
- **PR and review screen** next to the story's acceptance criteria and the reviewer's verdict (hermes3d PR review screen, agent-orchestrator reviewer flow).
- **Usage panel** with cost per model and agent and budget alerts (hermes3d analytics).
- **Map of components and file activity** (agenttrail Map): which part of the codebase each running story touches, useful to see collisions.
- **Spatial or office view** (hermes3d, agenttrail Kitchen) only as an optional, low-priority view, never the primary one.
- **Remote, read-only view of an office** (hermes3d multi-agent beta) as a later idea for checking progress from another device.

More GUI patterns with file paths are in section 6.6.

## 6. Context and token optimizations

A dedicated research pass looked at code graphs, context shaping, work avoidance and model routing in the three tools. Tags: AO = agent-orchestrator, AT = agenttrail, H3 = hermes3d. Paths are relative to each repository.

### 6.1 Code graphs and repo maps

- **No code graph was found in any of the three.** Reading the repositories through the API found no static parsing, tree-sitter, LSP or symbol index in AO or H3, and AT does not parse code either.
- **AT declares a component map by hand** in `PLAN.md`: components with ids, `files:` globs, `needs:` and `links:` edges, and a status marker (`bin/agenttrail.mjs`: `parsePlan`, `globToRe`, `touchComponents`). Glob regexes map every written file to a component, which drives the UI and handoff detection. A linter warns about edges to unknown ids, components without globs, done items without evidence, and more than nine components.
- **AT caps its file tree** (breadth-first, 4000 nodes, 250 per directory, depth 8, ignore list) (`buildTree`).

What this means for us:

- A **declared component map** (components, file globs, dependencies), versioned in the repository, gives cheap scope checks, collision checks and "which part of the system is this story touching" without parsing code. It fits "code drives": the map is data, checks are code.
- A **real code graph** (symbols, imports, call edges) that gives a worker the relevant slice of the codebase instead of letting it explore is not done by any of these tools. It is a promising way to cut tokens, and an open question for DIPO-10: build one (for example with tree-sitter), reuse an existing repo-map approach from other tools **[to research]**, or rely on the declared map plus the story's scope.
- Any map injected into a prompt must be capped, as AT does.

### 6.2 Context shaping for workers

| Pattern | Source | How it applies to us |
|---|---|---|
| Pre-fetch facts in code and tell the worker not to re-fetch them | AO `backend/internal/session_manager/prompt.go` | The prompt carries the story, scope, inputs and run knowledge. The worker starts working instead of exploring. |
| Cap every injected text, with a truncation marker | AO `backend/internal/service/session/issue_context.go` (12,000 characters) | Every section of an assembled prompt has a size budget. |
| Feedback carries the evidence | AO `backend/internal/lifecycle/reactions.go` (log tails, `file:line`, comment bodies) | CI, review and test feedback to a worker includes the failing output and locations, so it does not need to investigate. |
| Keep a reviewer warm | AO `backend/internal/review/prompt.go` | Not adopted, see 6.9. (It would mean one standing reviewer session per office instead of a new reviewer each time.) |
| Budgeted handoff, not the whole transcript | AO `handoff_artifact.go`, `source_semantic_handoff.go` (600 lines or 64 KB) | When work moves to another session or role, pass a bounded summary. |
| Resume instead of re-prime | AO `backend/internal/service/chat/hibernate.go`, H3 `server/hermes-agent/bridge.js` | Resume the native agent session for a parked or returning story. |
| Record compaction as an event | AO `migrations/0069_conversation_compaction.sql` | Usage and health data stay correct across context compaction. |
| Conditional one-line nudges through hooks | AT `relayHook` and `/nudge` (only when the plan is stale, 400 ms cap, silent on failure) | Inject short context only when a fact makes it relevant, for example "your branch is behind the base". |

### 6.3 Avoiding repeated work

| Pattern | Source | How it applies to us |
|---|---|---|
| Send-once with a content signature and attempt budget, persisted across restarts | AO `reactions.go` (`sendOnce`, `ciFailureSignature`), `migrations/0005_pr_last_nudge_signature.sql` | The feedback loop (idea 5) never repeats the same nudge and respects the loop cap. |
| Review keyed on commit | AO `backend/internal/review/planner.go` | Never review the same commit twice. |
| Conditional requests and batching against GitHub | AO `backend/internal/observe/scm/observer.go` (ETags, batched fetches, rate-limit cooldown) | Polling forge state stays cheap. |
| Transcript tailing from a durable byte offset | AO `backend/internal/observe/usage/ingestor.go`, AT `connectors/logs.mjs` | Usage ingestion resumes where it stopped after a restart. |
| Short caches with single-flight and invalidation | AO `workspace_cache.go`, `workspace_manifest_index.go` | Repeated reads of git and workspace state are cheap. |
| Prepare the worktree before it is needed | AO `task_preparation.go` | Create the worktree and install while the batch is being confirmed. |
| Debounce and send only changes | AT (150 ms debounce, broadcasts at most once per second, deltas) | Event stream sends deltas; clients are not flooded. |
| Deduplicate notifications and close them from facts | AO `backend/internal/notify/manager.go` | The "needs you" list never repeats and clears itself when the fact changes. |

### 6.4 Model routing

- AO stores model and effort per session, chosen by the user (`migrations/0100_session_model.sql`, `0152_session_effort.sql`). H3 gives each agent profile a fixed model.
- **None of them routes models by task difficulty.** Our tiers (S, M, L mapped to model and budget) are new ground.

### 6.5 Status digests without a model

- H3 builds standup cards in code from the tracker, git commits and notes, with no LLM call (`src/lib/office/standup/service.ts`).
- For us: the overview, the morning triage list and a daily digest are built by code from facts. A model may summarise only when the maintainer asks.

### 6.6 Additional GUI patterns

- AO board with derived lanes (`frontend/src/renderer/components/SessionsBoard.tsx`), session detail with an inspector rail (`SessionView.tsx`, `SessionInspectorRail.tsx`), diff review with "ask about this selection" (`diffs/WorkspaceReviewPane.tsx`, `diffs/SelectionAskButton.tsx`), terminal panes, notification centre and command palette, and a per-session panel with CPU, memory, tokens and estimated cost (`SessionMemoryPanel.tsx`). Some of these were judged from file names only **[partly unverified]**.
- AT map of component cards with dependency arrows, live file activity, session trails, a stale-plan banner and lint results (`public/index.html`).
- H3 kanban that collapses nine backend states into five columns and only lets a drag perform transitions a human is allowed to make (`server/hermes-agent/kanban.js`); file diff modal, inbox panel and fleet sidebar **[unverified]**.

### 6.7 Ideas adopted from this pass

| # | Idea | Owner |
|---|---|---|
| 13 | Prompts carry pre-fetched facts, every section has a size budget, and the worker is told not to re-fetch | DIPO-10 |
| 14 | Feedback to a worker carries the evidence (log tails, locations, comment text) | DIPO-10, M1 |
| 15 | Budgeted handoff between sessions or roles; resume a native session before starting a new one | DIPO-10, DIPO-5 |
| 16 | Conditional short context nudges through hooks, only when a fact makes them relevant | DIPO-10 |
| 17 | Send-once signatures and review keyed on commit, persisted across restarts | M1 |
| 18 | A declared component map (components, globs, dependencies) in the repository for scope and collision checks | DIPO-7, M2 |
| 19 | Evaluate a code graph or repo map that gives a worker the relevant slice of code | DIPO-10 |
| 20 | Overview, triage list and digests built by code from facts, no model | DIPO-6 |
| 21 | Event stream sends deltas, debounced; usage tailing resumes from a stored offset | DIPO-2, DIPO-4 |
| 22 | Prepare worktrees (create and install) while a batch is being confirmed | M2 |

### 6.8 Terms are placeholders

Some words in this document come straight from the tools: the evidence labels (reported, observed, inferred, unknown), health state names (waiting, blocked, error), the column name "Needs you", and "send-once". They are used here only to describe the idea. The owning spike or milestone (DIPO-6, M1) chooses our own vocabulary, per decision 0015.

### 6.9 Not adopted on purpose

- **A warm, reused reviewer session** (6.2) saves tokens but could weaken reviewer independence (decision 0002: the reviewer never sees the implementer's reasoning). If it is ever proposed, it must be checked against 0002 first.

## 7. Maintaining this document

- New comparable tools are added with the same structure: what it is, maturity, model compared with ours, adopt, avoid, GUI and optimization notes.
- When an adopted idea is implemented or rejected, update its row with the outcome.
- Re-check maturity figures before relying on them; they change fast.
