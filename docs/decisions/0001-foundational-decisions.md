# 0001 Foundational decisions

Status: accepted (grill session, 2026-10-09). Technical stack is deliberately undecided and handled in a later session.

## Product shape

- **Tool, not skill.** The orchestrator is a program with physical commands.
- **Ritual commands**, connected to Backlog.md and to interactive Claude interview sessions:

  | Ritual | Command | Code does | Model does |
  |---|---|---|---|
  | Plan | `plan` | Creates draft stories (temporary ids; real ids and branch names are assigned at refine, see 0012), collision check | Interviews the user, decomposes the goal |
  | Refine | `refine <id>` | Checks completeness against the story standard | Finds gaps and unknowns, asks the user |
  | Estimate | `estimate <id>` | Stores the size | Proposes a size, the user confirms |
  | Ready gate | `ready <id>` | Hard checks: acceptance criteria, scope, dependencies, no open unknowns | Nothing |
  | Run | `run` | Selects the batch, spawns workers, parks stuck stories | Implements, verifies, reviews |
  | Review | `review` | Shows diff and verdict, records the user's decision | Independent reviewer judges |
  | Retro | `retro` | Aggregates parked reasons, loops, cost | Suggests how to prepare better |

- **v1 scope:** `plan`, `refine`, `ready`, `run`, `review`. `estimate` and `retro` follow.
- **Lifecycle:** `Draft -> Refined -> Ready -> In Progress -> In Review -> Done`, plus `Parked` as a side state.
- **The engine refuses to run a story that is not Ready.**
- **No sprints.** Continuous flow from the Ready queue.
- **`run` includes review.** Phases are composable and can be skipped or added by configuration.
- **Estimation** sizes overnight batches and sets per-story budget caps. It is not velocity tracking.

## Architecture constraints

- **Engine is headless and separate from the UI.** The engine exposes commands in and events out. Clients use only that interface.
- **Daemon from the start.** The engine runs detached so workers survive closing the UI. Overnight runs are a core use case. The daemon holds a keep-awake assertion while work is active.
- **TUI first.** A local web UI or desktop app can follow as additional clients of the same engine.
- **Worker adapter interface.** The engine defines a small `Worker` contract (start with prompt and workdir, stream events, accept steering, return result). The first adapter wraps the **Claude Code CLI as a subprocess**, using the user's Max subscription login. An SDK or API-key adapter is a possible later swap and is an open question, because subscription OAuth use outside Claude Code is restricted by Anthropic's terms.
- **Shared plan limits.** Overnight runs draw from the same subscription limits as daytime use, so budget caps are required, not optional.

## Unattended behavior

- A worker that needs a human **parks** its story and the run continues. The story keeps its branch and worktree.
- Park reasons are structured: `ambiguous-spec`, `verify-failing`, `conflict`, `scope-violation`, `review-blocked`, `budget-exceeded`, plus `on-hold` when the maintainer puts a Refined or Ready story aside by hand (0012).
- Stories depending on a parked story stay blocked. Independent stories continue.
- Hard caps per story: loop count, review rounds, token or time budget.
- The morning view is a triage list of parked stories with reason, last good commit, and actions (answer and resume, amend the story, drop).

## Data ownership

- **Backlog.md / Backlog CLI is the source of truth for stories:** title, outcome, acceptance criteria, dependencies, scope, status, estimate, open unknowns.
- **Git is the history engine for code and for the durable story record.**
- **A local database holds orchestration state:** runs, worker events and output, loop counts, cost, reviewer verdicts in full, parked reasons, gate decisions, process and daemon state. It is per project, local and gitignored. It is the state of the orchestration and the insights of the user's machine.
- On close or park, the engine writes a short structured summary back onto the task so git carries the durable highlights.
- On daemon start the engine reconciles database, Backlog.md and git branches. Git and Backlog.md win on story facts, the database wins on run detail. Mismatches surface as a visible warning, never a silent fix.
- Losing the database loses detailed history, never the project.

## Way of working for this repo

- Backlog.md for stories from day one, plus project rules in `CLAUDE.md`.
- The existing `dipsaus-ai` backlog skills are inspiration only and are not a dependency.
- The first commits go directly to `main`. Once a proper initial backlog exists, work moves to `<ID>/<slug>` branches with parallel delivery.
- Cutover to self-hosting happens when `run` can deliver one story end to end.

## Amendments

- 2026-10-10, decision 0012 (story standard): `plan` creates Backlog.md drafts with temporary ids; real ids and branch names are assigned at `refine`. New park reason `on-hold` for stories the maintainer puts aside by hand. Lifecycle state names are defined in 0012.
- 2026-10-10, decision 0005: park reasons `stopped` (maintainer ended a worker) and `interrupted` (worker lost while the daemon was down).
- 2026-10-10, decision 0008 (maintainer): park reasons `needs-permission` (worker cannot finish without a denied action) and `worker-failed` (worker crashed again after one resume).
- 2026-10-10, decision 0007 (maintainer): "local database per project" becomes local work state per project, kept in one central local database keyed by office; never in the repository and never the only copy of a story fact.
