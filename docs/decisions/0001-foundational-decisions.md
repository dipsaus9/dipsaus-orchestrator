# 0001 Foundation

Status: accepted. First written 2026-10-09. Rewritten 2026-10-24 to describe the simplified design; it now also holds the office model (former 0011) and the build-our-own rule (former 0015). The research behind the rewrite is in `docs/research/2026-10-24-simplification-audit.md`.

## Product

dipo is a program with commands. It is not a skill that a model rereads and re-executes on every run.

One person, the maintainer, runs their software products with it the way a small office would. The maintainer plans, decides and tests. dipo's code does everything it can know or do. Agents, which are AI workers created from roles, do the work that needs judgment or content.

## The office

- **One office per project.** A project is a git repository with a Backlog.md backlog. Its stories, agents, planning and state belong to that office. Offices do not know about each other.
- **The software above the offices** keeps only the list of known offices. The maintainer opens a repository as an office, sees each office's status and switches between them.
- **Shared limits are the one exception.** All offices draw from the same subscription, so spend alerts and plan-limit waits look across offices. Nothing else crosses.

## Principles

Every other ADR follows these. A design that breaks one is wrong, or this ADR changes first.

1. **Code drives, AI fills the gaps.** If dipo already knows an answer from the backlog, git, GitHub or its own state, it does not ask a model. Anything deterministic is code, never prose for a model to follow.
2. **Prepare, don't repair.** A story runs only after it passes the Ready gate (0012).
3. **The engine is headless.** Clients send commands and read events. The engine never changes its behaviour based on which client is connected.
4. **Park, don't guess.** A story that cannot go on parks with a reason, and the rest continues. Parked is the only waiting state.
5. **Effort follows difficulty.** A story's tier sets its model and its caps. A cap is never raised without a maintainer command.
6. **Model-agnostic at the edge.** Claude is reached only through the worker adapter (0008). Claude names stay out of the engine and the contract.
7. **One source per fact.** Every fact has one owner (see Data ownership). A second copy is a cache and never overrules the owner.
8. **One mechanism per goal.** When a gap needs a fix, the fix replaces the mechanism that failed instead of adding one beside it (0003).
9. **Built to last.** Each milestone is production quality for its scope (0003).

## Lifecycle

A story moves `Draft → Refined → Ready → In Progress → In Review → Done`. `Parked` is the one side state. A story leaves it through `dipo resume`, or by itself after a plan limit lifts (0020). `Removed` holds dropped stories. The state names and their rules are in 0012.

There are no sprints. Work flows from the Ready queue.

## Unattended work and parking

Work can run without the maintainer, overnight included.

- A story that needs a human parks with one of eight reasons:
  - `ambiguous-spec`: the worker asked a question, or reported it is blocked, and needs the maintainer's answer.
  - `verify-failing`: the verify or the required checks stay red at their cap.
  - `conflict`: a conflict the worker could not resolve within its cap.
  - `scope-violation`: a delivered part touched a protected file or held a secret.
  - `review-blocked`: the reviewer blocked it at the round cap.
  - `budget-exceeded`: a cap was crossed.
  - `by-maintainer`: the maintainer parked it with `dipo park`.
  - `worker-failed`: the worker, its box or its host failed, or was lost while the daemon was down.
- A parked story keeps its branch and its box. Stories that depend on it stay blocked; independent stories continue.
- Every story has hard caps: tokens, turns, time, loops and review rounds (0008, 0002).
- The desk lists everything that waits on the maintainer: parked stories with their reason and actions, open questions, and gates waiting for a decision (0009).

## Data ownership

| Owner | Facts |
|---|---|
| Backlog.md, through the Backlog CLI | Story facts: title, outcome, criteria, dependencies, references, tier, test plan, status and park reason. dipo writes status and park reason itself, through the CLI, never by editing the file |
| Git and GitHub | Code, branches, pull requests, CI results and merges |
| dipo's local database (0007) | Run detail only: runs, worker output, usage and cost, reviewer verdicts, gate decisions and claims. One database for all offices, keyed by office, never inside a repository |

Losing the database loses history, never the project. At daemon start dipo reconciles its database against Backlog.md and git. On a mismatch, Backlog.md and git win, dipo corrects its own copy and shows a notice.

## Architecture constraints

- **A daemon from the start.** The engine runs detached, so work survives closing a client, and it keeps the Mac awake while work runs (0005).
- **macOS on Apple silicon** is the platform (0004).
- **Every worker runs in a box,** one per story (0008).
- **The TUI is the first client** (0009). Later clients use the same commands and events.
- **The worker adapter** starts a worker with a prompt, streams its events, accepts steering and returns a result. The first adapter wraps the Claude Code CLI on the maintainer's subscription login (0008).
- **Commands are the only way to act on the engine.** A later conversation layer (M5) maps the maintainer's words to commands and asks for confirmation. It can never do what no command can.

## Roles

An agent is created from a role: purpose, instructions, allowed tools, default model and effort. A role is a versioned file in the office's repository, and hiring adds it to the office's roster. Code chooses the role per story without asking a model. Every role works the same way: all work is a story, and all output lives in the repository on a branch, is reviewed against the story's criteria and is merged. Until M4 there is one built-in developer role and the reviewer (0003).

## Build our own

Comparable tools (`docs/research/2026-10-comparable-tools.md`) are a source of ideas only.

- dipo copies no code, naming or command syntax from them, and has no runtime dependency on them.
- An adopted idea is restated in dipo's own terms and must fit the principles above.
- If code is ever reused, its licence and attribution are honoured in that change.

## Way of working on this repository

- Stories live in Backlog.md, and project rules in `CLAUDE.md`.
- Work happens on `<ID>/<slug>` branches and merges by PR. A separate agent reviews every PR (0002).
- dipo has delivered its own stories since the cutover (DIPO-115).

## Replaced

- One database per project. Replaced by one central database keyed by office (2026-10-10), because a single daemon serves all offices.
- References as a write fence on what a worker may change. Replaced by references as a forecast plus protected files (2026-10-21), because the box makes the fence unenforceable and unneeded.
- Eleven park reasons, including `stopped`, `on-hold`, `interrupted` and `needs-permission`. Replaced by the eight above (2026-10-24): `by-maintainer` covers stop and hold, `worker-failed` covers interrupted, and a box worker never needs a permission.
- A first command list (`plan`, `refine`, `estimate`, `ready`, `run`, `review`, `retro`). The rituals now live in the milestones (0003).
