# 0014 Worker prompt assembly and the context provider

Status: Proposed (spike DIPO-10, 2026-10-10).

## Context

The project's core token claim (vision, "The problem with the current approach") is that a worker should get a short prompt built by code from structured data, not a process manual it reads and re-executes. Decisions this builds on: 0001 (code decides, park reasons, worker adapter), 0002 (independent reviewer, test plan), 0004 (TypeScript on Bun, `claude -p --output-format stream-json`), 0011 (roles as versioned files, tiers), 0012 (story fields F1 to F18), 0015 (inspired, not dependent), the draft 0017 (`.dipo/office.yaml`, `.dipo/roles/<name>.md` with YAML frontmatter, recordings keep usage fields for this ADR) and research sections 6 and 7 (ideas 13 to 16, 19, 23 to 27, the codegraph decision in 7.7).

Ownership: DIPO-5 owns the Worker contract, transport and flags; DIPO-4 the state tables and budget units; DIPO-7 the field block and the component map file; M4 the role file fields. This ADR owns what goes into a prompt, in which order and size, what never does, the context provider, and how savings are measured.

### The baseline: what a worker reads today

dipsaus-ai `skills/backlog-deliver` at commit 388f940 (2026-08-21), measured with `wc`:

| File | Lines | Words | Bytes |
|---|---|---|---|
| `SKILL.md` (always loaded on invocation) | 321 | 3,254 | 21,335 |
| `reference/git-contract.md` (read before every commit) | 75 | 670 | 4,353 |
| `reference/parallel-delivery.md` (gate, read when unclear) | 210 | 1,649 | 10,533 |
| `reference/review-and-pr.md` (review gate, push) | 185 | 1,356 | 9,044 |
| Total | 791 | 6,929 | 45,265 |

At 3.5 to 4 characters per token that is about 5.5k tokens for `SKILL.md` alone and 11k to 13k tokens with the references, before the story, the repository or any exploration. The skill also points to backlog-plan's `story-standard.md` (6.3 KB) and spawns `agents/story-reviewer.md` (3.7 KB). Most of this text tells the model how to do things code can do: gate checks, branch naming, worktrees, base sync, commit rules, push, PR mode, teardown. These are estimates; the measurement below replaces them with counted usage.

### Verified facts about Claude Code (2026-10-10)

- System prompt flags: `--append-system-prompt[-file]` appends to the default prompt and keeps tool guidance and safety text; `--system-prompt[-file]` replaces it all. A line `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` in a replacement prompt splits it into a cached static part and a dynamic part (v2.1.275+) [1][2].
- The system prompt is recorded on a session's first request and reused on `--resume` until compaction; different flag text on resume takes effect only after compaction or in a new session (`--system-prompt-snapshot off` changes this) [1].
- `--exclude-dynamic-system-prompt-sections` moves per-user context (the auto memory path) out of the system prompt into the first user message, so identical configurations share one cache entry across users and checkouts. It applies with the default prompt, including append [1][2].
- Cache order is tools, system, messages; the match is an exact prefix. Tool definitions and the system prompt sit first, CLAUDE.md and the environment (working directory, git status snapshot) come in the conversation, so two worktrees share at most the tools plus system prefix. A model switch, an effort change on older models, adding MCP tools that load up front, or a Claude Code upgrade rebuilds the cache [3][4].
- TTL: on a Claude subscription within plan usage the main `-p` conversation gets a one hour TTL, subagents five minutes; `CLAUDE_CODE_PROMPT_CACHE_TTL` and `promptCacheTtl` set it (v2.1.242+). Cache reads cost 0.1x input (0.05x on Opus 5.5 and Sonnet 5.5), five-minute writes 1.25x, one-hour writes 2x. Minimum cacheable prefix is 512 tokens on the 5.5 models [3][4].
- `includeGitInstructions: false` and empty `attribution` remove Claude Code's own commit and PR instructions and trailers [2].
- Hooks can return `additionalContext` on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop` and others; each string is capped at 10,000 characters [5].
- `--resume <id>` continues a session by id, `--session-id <uuid>` sets the id up front, `--fork-session` branches it [1].
- Anthropic's prompting guidance: long documents near the top, the query and instructions at the end; this improves quality by up to 30% on multi-document inputs [6].

## Options

### Prompt delivery

- **A. Hand the worker a skill or manual (status quo).** Every run pays for 11k+ tokens of process text and re-derives mechanical steps. Rejected; this is the problem.
- **B. Replace the system prompt (`--system-prompt-file`).** Smallest prompt, but drops Claude Code's tool guidance and safety text, and we would own keeping it current. Kept as an option for non-code roles in M4 only.
- **C. Write story context into the worktree's `CLAUDE.md`.** Changes a tracked file and leaks into the diff. Rejected.
- **D. Default system prompt plus an appended static contract and role, with all story data in the first user message (chosen).** Keeps Claude Code's defaults, keeps the appended part byte-identical across stories so it caches, and puts volatile data where it belongs.

### Context backends

Section 9 of the decision compares codegraph, Aider's repo map, Serena and code-graph-rag against the default provider.

## Decision

### 1. Layers, and where each template lives

| Layer | Content | Delivered as | Lives in | Changes when |
|---|---|---|---|---|
| L0 | Claude Code default system prompt and tools | Default, with `--exclude-dynamic-system-prompt-sections` | Claude Code | Claude Code upgrade |
| L1 | Worker contract: what the engine does, what the worker returns, "facts are pre-fetched, do not re-fetch" | `--append-system-prompt-file`, first part | `packages/engine/src/prompts/contract/<kind>.md` (`implement`, `review`) | Engine release |
| L2 | Role instructions | Same file, after L1 | `.dipo/roles/<name>.md` body (0017); built-in `developer` and `reviewer` in `packages/engine/src/prompts/roles/` until M4 | Role edit (a git commit) |
| L3 | Project rules | Claude Code's own `CLAUDE.md`/`AGENTS.md` loading | The office repository | Repository edit |
| L4 | Task message: story data, context pack, handoff, feedback | First user message | Section templates in `packages/engine/src/prompts/task/` | Every story |
| L5 | Later turns: feedback, maintainer answers, nudges | New user messages or hook `additionalContext` | `packages/engine/src/prompts/feedback/`, `nudges.ts` | Every event |

Rules:

- Templates are logic-free Markdown with named slots (`{{criteria}}`). Code decides whether a section appears, fills it, applies budgets and orders it. A template never contains a conditional or a loop.
- L1 and the section templates are engine code. An office cannot override them, because they carry the code/AI boundary. An office tunes roles (L2), budgets and the context backend, all in `.dipo/`.
- The rendered L1+L2 file and a sample L4 per kind are golden files in tests (0017), so a template change shows up as a reviewed diff.
- Section headings are fixed and wrapped in XML-like tags (`<outcome>`, `<criteria>`) so the contract can refer to them by name.

### 2. What each prompt receives

The task message (L4) for the `implement` kind, in this order: long reference material first, the story contract and feedback last [6].

| # | Section | Source | Included when |
|---|---|---|---|
| 1 | `context` | Context provider pack (section 9) | Always (may be small) |
| 2 | `inputs` | F9 paths; file content pre-fetched within budget, URLs listed only | Story has inputs |
| 3 | `dependencies` | Title and outcome line of each F7 dependency, one line each | Story has dependencies |
| 4 | `background` | Free text in the description outside the `Outcome:` line and field block | Non-empty |
| 5 | `handoff` | Section 6 | New session for a story with earlier work |
| 6 | `story` | F1 id, F2 title, F5 type, F11 tier | Always |
| 7 | `outcome` | F3 | Always |
| 8 | `criteria` | F4, numbered as in Backlog.md | Always |
| 9 | `scope` | F8: "you may write only these paths" | Always |
| 10 | `test_plan` | F14 automated entries (tests to write) and manual entries (behavior the maintainer will check) | Non-spike |
| 11 | `answers` | F10 resolved unknowns, question and answer | Any resolved |
| 12 | `instructions` | F17 extra instructions | Non-empty |
| 13 | `feedback` | Section 7 | A fix turn |

Precedence, stated once in L1: the contract (scope, no git, report format) beats story instructions, story instructions beat role defaults, and project rules (L3) apply throughout. A conflict between project rules and the contract makes the worker report `blocked`, which parks the story with `ambiguous-spec`.

The worker ends a turn with a structured report: status (`done` or `blocked`), per criterion met or not with evidence, a one-paragraph summary, a proposed commit subject, an optional question (becomes the park note) and notes for a next session (at most 1,500 characters). The transport (`--json-schema` or a fenced block) is DIPO-5's choice.

The `review` kind receives: outcome, criteria, scope, test plan, the changed-path list and the diff relative to the merge base (`git diff <base>...HEAD`) without the story's own task file (budgeted, section 4). A re-review additionally gets only the previous findings. The reviewer always starts a fresh session and is never resumed (0002, research 6.9). It never receives the implementer's handoff, notes, reasoning or transcript.

Privacy: the engine stores no prompt text and no transcript. Per run it keeps the sha256 and size of each prompt part and the usage numbers. The worker's notes for a next session go to the state database (DIPO-4) and are deleted at worktree teardown. Claude Code's own transcripts are left to Claude Code.

Left out of every prompt: process rules (gate, lifecycle, git contract), Backlog.md CLI usage, other stories beyond dependency one-liners, labels, priority, ordinal, definition of done, park records (except the maintainer's answer), office configuration and budget numbers, earlier transcripts, run knowledge already acted on by code (install and start scripts), and anything code can answer at run time.

### 3. Steps that stay in code and never appear as instructions

Selection, Ready and pickup re-check, dependency and collision checks, branch name and slug, worktree creation, install and gitignored-file setup (DIPO-7), base sync, every Backlog.md write (status, criteria check-off, notes, final summary), running verify and judging it, staging only scope paths and committing, push, PR, spawning the reviewer and parsing its verdict, round, loop and budget caps, parking, teardown, model, effort and tool choice per tier and role, context selection and index freshness, resume or new session, usage capture.

**Verify and commit happen at the In Review transition.** When the worker reports `done`, the engine runs verify. Green: it checks off the criteria the report marks met, stages only scope paths, commits (subject from the worker's proposal plus the story id) and moves the story to In Review. Red: the failure becomes feedback and the worker continues. The same gate runs on re-entry after a fix round. Verify does not run per worker turn.

**No mid-implementation commits.** Work between turns lives in the worktree, which survives a worker or daemon crash (DIPO-7 keeps it until teardown). A handoff captures it with `git diff --stat HEAD` and the untracked-file list from `git status --porcelain`. Chosen over unverified checkpoint commits per turn because every commit on a story branch then stays green, history needs no squash, and there are fewer git operations. The cost: one commit per In Review round instead of one per slice.

**Base sync only when needed.** The engine syncs the story branch with the base only when a conflict with the base is detected (for example with `git merge-tree --write-tree`, which leaves the worktree alone) or when the story counts as riskier; code decides, DIPO-7 defines "riskier". Conflict feedback (section 7) only arises from such a sync. Diffs and logs are relative to the merge base (`git diff <base>...HEAD`, `git log <base>..HEAD`), so an unsynced branch still shows only its own work.

**Requirements handed to DIPO-5** (the flags are its decision; these are the effects needed): git write commands (`commit`, `push`, `checkout`, `switch`, `merge`, `rebase`, `reset`, `stash`, `worktree`), `backlog` and `gh` are unavailable to the worker, for example via `--disallowedTools`; nobody answers permission prompts (`--permission-prompts none`); Claude Code's own commit guidance and trailers are off (`includeGitInstructions: false`, empty `attribution`) [2]. L1 holds one boundary sentence ("the engine handles git, Backlog.md, verify and review; report instead"), so a worker does not waste a turn on a denied call. The worker may run tests and read-only git (`git diff`, `git log`, `git status`).

**Backstop in code.** After every worker turn the engine checks that HEAD and the checked-out branch are unchanged. If not, it parks the story with `scope-violation`, whatever the tool rules said.

### 4. Size budgets and truncation

Budgets are in characters, because code can count them without a tokenizer; reports show both characters and an estimated token count. Every section has a budget. Truncation is deterministic and cuts on line boundaries; logs keep the tail, everything else the head. Every cut leaves a marker:

```
[dipo: truncated, showing 4,000 of 18,240 characters. The rest is in docs/spec.md from line 112; read it only if the shown part is not enough.]
```

Project size class comes from `git ls-files | wc -l` at pickup (code, no model): S under 150 files, M under 500, L under 5,000, XL above (the first three follow codegraph's own steps [7]).

| Section | S | M | L | XL | Note |
|---|---|---|---|---|---|
| `context` pack | 12,000 | 18,000 | 24,000 | 32,000 | Per item at most 4,000 |
| `inputs` content | 8,000 | 12,000 | 16,000 | 20,000 | Per file at most 4,000; the path list is never cut |
| `dependencies` | 1,500 | 1,500 | 2,000 | 2,000 | |
| `background` | 2,000 | 2,000 | 3,000 | 3,000 | |
| `handoff` | 6,000 | 6,000 | 6,000 | 6,000 | |
| `feedback`, per item / total | 3,000 / 8,000 | same | same | same | Log tail at most 60 lines |
| `diff` (review kind) | 40,000 | 60,000 | 80,000 | 80,000 | Over budget: per-file stat plus the largest hunks; the reviewer reads the rest from the worktree |
| Nudge | 300 | 300 | 300 | 300 | One per fact signature |

Story contract sections (`story`, `outcome`, `criteria`, `scope`, `test_plan`, `answers`, `instructions`) are never truncated. Their total is capped at 12,000 characters. Proposed Ready gate rule for an amendment of 0012 (field storage via DIPO-7): **R26**, the characters of title, outcome, criteria, scope paths, test plan, resolved unknowns and extra instructions together are at most the office's `prompt.contractMax` (default 12,000); message `story contract is <n> characters; the limit is <max>`. `ready` then catches it before any run. Backstop: if assembly still finds the contract over the cap, the run does not start and the story returns to Refined with the assembly error, like a failed pickup re-check.

Total cap for the task message (L4): S 40,000, M 50,000, L 60,000, XL 70,000 characters (about 10k to 18k tokens). Over the total cap, sections are dropped in this order with a marker: dependencies, background, context tail, inputs content (the list stays). Budgets live in `office.yaml` under a `prompt.budgets` key (shell from 0017), may be overridden per tier, and are tuned from measured data, not guesses.

### 5. Stability for prompt caching

- L1+L2 are byte-identical for every story with the same role and engine version: no ids, dates, paths or counts. Its sha256 is stored per run.
- Workers start with `--exclude-dynamic-system-prompt-sections`, one fixed `--mcp-config` per office with `--strict-mcp-config`, a fixed tool list per role, and the tier's model and effort for the whole session. Each of these sits in the cached prefix [3][4].
- Rendering is deterministic: sorted lists, normalised newlines, no timestamps. The same story and commit give the same L4 bytes (golden test).
- Within a session, new information is appended as user messages or hook context, never by changing L1+L2.
- The engine records `cache_creation_input_tokens` and `cache_read_input_tokens` per run (0017 keeps them in recordings). A run whose system hash changed without an engine or role change is flagged in the overview.
- In production the TTL stays at Claude Code's default (one hour for the main conversation on the subscription). Changing it is a measured decision, not a default. The measurement pins it (see Measurement).

### 6. Budgeted handoff and native resume

Resume first, for workers only. The reviewer always gets a fresh session (section 2). For the same story and role, the engine resumes the native session (`--resume <id>`, the id set at start with `--session-id`) and sends only the delta (feedback, answer, nudge) when all hold: the transcript exists, the Claude Code version and L1+L2 hash are unchanged (a recorded system prompt would hide a role change [1]), the last known context use is under 60% of the window, and the expected cost of re-reading the history is not more than three times the cost of a handoff. The last check uses the session's last usage numbers and whether the cache is still warm (time since last request against the TTL). A parked story resumed the next morning has a cold cache, so a long session usually gets a handoff instead.

Otherwise a new session gets a handoff (the `handoff` section of the task message), assembled by code: commits on the branch since the merge base (`git log --oneline <base>..HEAD`), uncommitted work (`git diff --stat HEAD` and untracked files), criteria status from the last report, the last verify result, open feedback, and the previous worker's notes for a next session (the only model-written part, at most 1,500 characters). Never a transcript. A handoff to another role (for example developer to tester) uses the same block. The reviewer never gets one.

### 7. Feedback carries the evidence

Each feedback item is built by code from the failing fact, with a signature for send-once handling in M1 (idea 17):

| Source | Evidence in the item |
|---|---|
| Verify | The failing step and command, exit code, the last 60 lines of output, and `file:line` locations parsed from known formats (tsc, oxlint, bun test) |
| Reviewer | Criterion number and text, finding text, `file:line` and the quoted code line, blocking or advisory |
| Maintainer test | The test plan entry, its expected result and the maintainer's note, verbatim |
| Conflict (only after a base sync, section 3) | Conflicted paths and the conflict hunks, within budget |
| Scope | The paths written outside scope and the declared scope |
| CI (M1) | Job name, failing step and log tail, same format as verify |

### 8. Conditional nudges through hooks

The engine passes session-scoped hooks in `--settings` (nothing is written to the repository, idea 12). A hook runs `dipo hook <event>`, which asks the daemon for facts and prints `additionalContext` only when a fact makes it relevant; otherwise it prints nothing. Time limit 2 seconds, silent on any failure, at most 300 characters, each fact signature once per session.

| Trigger | Fact checked by code | Nudge |
|---|---|---|
| `PostToolUse` on Edit or Write | Path outside scope | "`<path>` is outside the declared scope; the engine will reject it." |
| `PostToolUse` on Edit or Write | File was in the context pack | "The context shown for `<path>` predates your edit." |
| `PostToolUse` (any) | Usage passed 80% of the tier budget | "80% of this story's budget is used; finish the current criterion and report." |
| `SessionStart` on resume | An input file changed on the base since the last turn | "Input `<path>` changed on the base at `<sha>`." |

Nudges are counted per run, so their effect can be measured like any other prompt part. Blocking an out-of-scope write with a `PreToolUse` deny is possible with the same mechanism; it is an open question below.

### 9. Context provider

The context provider decides which code a worker sees. Interface (engine package, TypeScript):

```ts
interface ContextProvider {
  id: string;                     // "default", "codegraph"
  status(ws: Workspace): Promise<ProviderStatus>;      // ready | stale | missing | error, with reasons
  prepare?(ws: Workspace): Promise<void>;              // index or sync; runs before the worker, outside its budget
  gather(req: ContextRequest, budget: number): Promise<ContextPack>;
}
// ContextRequest: story id, outcome, criteria, scope, inputs, matched component ids, base and head sha, size class
// ContextPack: items [{ path, range?, text, reason }], usedChars, truncated, provenance { provider, version, indexState, staleFiles }
```

Rules: providers return items, never prompt prose; the engine renders them. Output is deterministic for the same inputs. The default provider always runs first; an optional backend fills the remaining `context` budget. A backend that is not `ready` is skipped and the pack's provenance says why; the run continues on the default.

**Default provider** (M0, no external tool, no model):

1. Scope: existing files in full when under the per-item cap, otherwise the head with a marker; directories as a capped file list (breadth first, at most 200 entries); a path that does not exist yet is marked new, with the file list of its parent directory.
2. Inputs: listed and pre-fetched into `inputs` (section 2).
3. Component map, when the office declares one (DIPO-7, idea 18): the components whose globs match the scope and their direct `needs` neighbours, with name, purpose line and capped file list.
4. Tests next to scope files by name (`x.ts` to `x.test.ts`), listed, not inlined.

**Optional codegraph backend** (M1, off by default, per office in `office.yaml`):

- The engine calls a pinned binary: office config names the version, the engine checks `codegraph version` against it and refuses to use a mismatch. It never runs `codegraph install`, which writes MCP config and a section into `CLAUDE.md`/`AGENTS.md` [7].
- Every call runs with `CODEGRAPH_TELEMETRY=0` and `DO_NOT_TRACK=1` [8], a 20-second timeout and a 1 MB stdout limit.
- `prepare`: `codegraph init` or `sync` in the worktree (one index per worktree, research 7.5). Copying the main checkout's index first is tried and measured, not assumed.
- `gather`: `codegraph context --format json --max-nodes <n> <query>`, where the query is the outcome and criteria text and `n` follows the size class. In v1.6.2 `explore` has no `--json` flag; `context --format json`, `status`, `query`, `callers`, `callees`, `impact` and `affected` do (`src/bin/codegraph.ts`) [9]. The JSON is parsed with a tolerant zod schema and capped to the budget by the engine.
- Optional MCP for workers: when the office enables it, the engine adds the pinned codegraph MCP server to the office's fixed `--mcp-config`, with the same telemetry environment. It is measured as its own arm, because a dense payload stays resident in the context window [7].

**Comparison of candidate backends** (research 7.6, facts checked 2026-10-10):

| | codegraph | Aider repo map | Serena | code-graph-rag |
|---|---|---|---|---|
| How | tree-sitter in a Rust kernel, SQLite graph, no LSP | tree-sitter tags ranked on a file dependency graph, default 1k-token map | Language servers (40+ languages) or a paid JetBrains backend | tree-sitter plus compiler frontends, graph in Memgraph, optional Qdrant vectors |
| Engine can call it as code | CLI with JSON (`context`, `status`, `impact`, `affected`) | No standalone interface; part of the aider chat app | MCP server only; no JSON CLI found | CLI and MCP; questions go through an LLM that writes Cypher |
| Runtime | Bundled Node runtime | Python, aider install | Python 3.13 via uv, plus language servers | Python, Docker for Memgraph |
| Budget control | `--max-nodes`, MCP budgets by project size | `--map-tokens` | Per-tool limits | Not documented |
| Freshness signal | `status --json`: pending changes, index state, worktree mismatch | Cache on file mtime | Language server state | Re-run update |
| Licence, maturity | MIT, v1.6.2 (2026-10-03), very active | Apache-2.0, last release v0.86.0 (2025-08-09) | GPL-3.0 app, MIT SolidLSP; v1.7.0 (2026-08-09) | MIT, v0.1.38 (2026-09-29) |
| Telemetry | On by default, env opt-out | None found | None found | Not checked |
| Fit | Good: code drives, JSON, capped | Idea only: a ranked, budgeted map we could build ourselves later | Worker-side tool for refactoring roles, not an engine backend | Poor: Docker and model calls per query, nondeterministic |

Sources: [7][9][10][11][12].

**Recommendation:** codegraph is the first optional backend, as decided in 7.7. Aider's ranked map is kept as an idea: if measurement shows the default provider lacks structure and codegraph is too heavy, a small tree-sitter map ranked by references, in our engine, is the next candidate. Serena may later be offered to a role as an MCP tool, not as a provider. code-graph-rag is not pursued.

### 10. Stale index detection and reconcile

- Before `gather`, the codegraph backend runs `codegraph status --json` in the worktree. It is `stale` when any count in `pendingChanges` (`added`, `modified`, `removed`) is non-zero, `index.reindexRecommended` is true, `index.state` is not `complete`, `index.pendingRefs` is non-zero, `worktreeMismatch` is set (an index borrowed from another checkout), or the version differs from the pin [9]. The engine then runs `sync` once and checks again; if still stale, the backend is skipped for this run.
- The engine stores, per worktree, the head sha and the git blob ids of scope and input files when a pack was built. After a daemon restart it compares them with `git ls-files -s` plus hashes of dirty files, rebuilds only changed packs and runs `codegraph sync`, which reconciles from content hashes (research 7.2).
- Staleness is an event with its reason. The overview shows it with an evidence label (DIPO-6). Stale data is never used silently: the pack's provenance records it and the worker sees a marker on affected items.
- Run knowledge staleness stays with the fingerprint of ADR 0013 (DIPO-9).

## Measurement

Goal: show, on real stories, how many tokens the assembled prompt saves against the dipsaus-ai baseline, and decide whether a context backend may become a default (idea 25).

**Arms.** A: baseline, `claude -p "/backlog-deliver <id>"` with the dipsaus-ai plugin pinned at a recorded commit. B: engine with the default provider. C: B plus codegraph through the CLI. D: C plus codegraph MCP for the worker.

**Stories.** At least 8 non-spike stories, mixed tiers (at least 2 each of S, M, L), from at least two repositories (this one after cutover and one dipsaus-ai project), each with a known good outcome. Each story is mirrored into the baseline's format (`To Do`, `Branch:` line, References) with the same text.

**Fairness.**

- Same base commit, same model, effort and Claude Code version, same project `CLAUDE.md`, `--setting-sources project`, the same MCP servers apart from the arm's own, and `--permission-prompts none` for all arms. The baseline's questions to a human count as a failure.
- Each run starts in a fresh worktree from the same commit. Each arm runs 3 times per story, order randomised. All arms run with `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` [3], and runs of the same story are at least one hour apart so no arm reads another's cache. Each run records `ephemeral_1h_input_tokens` and `ephemeral_5m_input_tokens` from `usage.cache_creation`, so a different TTL shows up. Cache reads are reported anyway.
- The baseline pushes to a local bare remote with `pr.mode: link` (the PR link is printed, never opened), so no real pushes or PRs happen.
- A run hit by a rate limit (`system/api_retry` with `rate_limit`) or by spend on usage credits instead of plan usage is discarded and rerun.
- The baseline does its own git, review and PR, which is exactly the overhead the claim is about, so whole-delivery totals are compared. Totals without the review step are also reported for both arms, so a difference in reviewer design cannot hide in the result.
- The comparison is per story (paired), not of pooled averages.

**Metrics per run**, from stream-json and the result message (0017 lists the fields): input, cache creation, cache read and output tokens, deduplicated by message id; `modelUsage` and `total_cost_usd` including subagents; turns; tool calls by kind, file reads before the first edit; the assembled prompt size per section (characters and estimated tokens); wall time. Outcome: verify green, reviewer rounds, criteria met, parked or not. Headline number: price-weighted input (uncached + 1.25 x five-minute writes or 2 x one-hour writes + the model's read rate x reads) plus output, per story, median of 3.

**Volume and schedule on the Max plan.** One full round is 4 arms x 8 stories x 3 runs = 96 runs (24 per arm), plus reruns. At most 12 runs per day, started overnight by the daemon, so a round takes about 8 to 9 days and leaves daytime plan usage to the maintainer. Arms A and B run first (48 runs, about 4 days); C and D run only when codegraph is ready (M1).

**Where.** A `dipo measure` dev command runs arms and stores results in the state database (DIPO-4) and a Markdown report under `docs/research/` per round. The measurement code is tested on recordings (0017); the measurement itself is never part of `verify`.

**Decision rules.**

- The token claim holds if B's median cost is lower than A's on at least 75% of stories with no lower success rate. The first report states the reduction found; no target is promised before it.
- A backend becomes the default only if it lowers median cost against B by at least 15% across the stories, with no drop in success rate and no story more than 25% worse. Otherwise it stays optional. Re-measured on a codegraph minor version or a notable Claude Code release.

## Consequences

- Workers start with roughly the story plus a capped context pack instead of 11k+ tokens of process text, and mechanical steps cost no model tokens. The size of the effect is unknown until the first measurement.
- The engine owns more: templates, budgets, report parsing, the commit step, hook endpoints and the measurement harness.
- The worker no longer commits. Code commits only at the In Review transition after a green verify, so every commit on a story branch is green. The cost: one commit per review round instead of one per slice, and work in progress lives only in the worktree until then.
- Prompt changes are code changes with golden tests; role changes are git commits in the office.
- Truncation can hide something a worker needs. The marker gives the path and line so it can read on, at a cost the measurement will show.
- Tool restrictions and settings depend on Claude Code flag behaviour (DIPO-5 recordings catch drift).
- codegraph adds an index per worktree (time and disk), a pinned external binary and an opt-out telemetry setting to manage.

## Open questions for the maintainer

1. **Commits by code.** Accept that the engine commits only at the In Review transition (after a green verify), with no mid-implementation commits and work in progress captured by `git diff --stat HEAD` in the handoff? Alternative: unverified checkpoint commits by the engine after each worker turn.
2. **Scope enforcement in the session.** Nudge on an out-of-scope write (proposed), or deny it with a `PreToolUse` hook?
3. **Budgets.** Accept the starting character budgets and size classes as defaults until the first measurement?
4. **Measurement thresholds.** 75% of stories for the token claim; 15% median gain and at most 25% worse on one story for a backend default. Right bars?
5. **Measurement stories.** Which repositories and stories form the first set, and may the baseline runs use the subscription (96 runs per full round, at most 12 per day overnight)?
6. **Resume rule.** Resume under 60% context use and when re-reading costs at most three times a handoff. Keep these as tunable defaults?
7. **Background text.** Include the free description text (budgeted), or only the Outcome line and fields?

## Sources

1. Claude Code docs, CLI reference (system prompt flags, dynamic boundary, recording on resume, `--exclude-dynamic-system-prompt-sections`, `--resume`, `--session-id`, `--disallowedTools`, `--permission-prompts`). https://code.claude.com/docs/en/cli-reference
2. Claude Code docs, Agent SDK: Modifying system prompts (append keeps defaults, exclude dynamic sections, `includeGitInstructions`, `attribution`, hook `additionalContext` for mid-session changes). https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts
3. Claude Code docs, How Claude Code uses prompt caching (layers, invalidation, TTL per bucket, cache scope per directory). https://code.claude.com/docs/en/prompt-caching
4. Claude API docs, Prompt caching (prefix order, TTLs, price multipliers, minimum lengths). https://platform.claude.com/docs/en/build-with-claude/prompt-caching
5. Claude Code docs, Hooks reference (`additionalContext` events, 10,000 character cap, timeouts). https://code.claude.com/docs/en/hooks
6. Claude API docs, Prompting best practices (long data at the top, query at the end). https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
7. codegraph README (CLI, installer behaviour, benchmarks and residual context note), v1.6.2. https://github.com/colbymchenry/codegraph
8. codegraph `TELEMETRY.md` (`CODEGRAPH_TELEMETRY=0`, `DO_NOT_TRACK=1`). https://github.com/colbymchenry/codegraph/blob/main/TELEMETRY.md
9. codegraph `src/bin/codegraph.ts` (commands and flags, `status --json` fields), read through the GitHub API 2026-10-10. https://github.com/colbymchenry/codegraph/blob/main/src/bin/codegraph.ts
10. Aider docs, Repository map, and `aider/repomap.py` (tree-sitter, `--map-tokens`); GitHub API for release and licence. https://aider.chat/docs/repomap.html
11. Serena README and `LICENSE` (language servers, MCP, GPL-3.0 app and MIT SolidLSP). https://github.com/oraios/serena
12. code-graph-rag README (Memgraph, Docker, Cypher generation by a model). https://github.com/vitali87/code-graph-rag
13. dipsaus-ai `skills/backlog-deliver/` at 388f940, measured locally with `wc` (baseline table).
