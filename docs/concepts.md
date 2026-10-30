# Concepts

Shared vocabulary, matching the ADRs in `docs/decisions/` (rewritten 2026-10-24). The ADR that defines each term is named at the end of its row.

| Term | Meaning |
|---|---|
| **Office** | One project as seen in the orchestrator: its backlog, roster, running work and state. Offices are isolated from each other (0001) |
| **Project** | A git repository with a Backlog.md backlog in which an office is initialised |
| **Office list** | The software-level list of known offices that the maintainer switches between. Holds no work state (0001, 0007) |
| **Maintainer** | The human: visionary, manager, tester. Decides direction and approves gates |
| **Orchestrator** | The code-driven core, plus the AI-assisted help that sets things up for the maintainer. Code first, AI to fill gaps |
| **Engine** | The headless part of the orchestrator: state, gates, scheduling, workers, git. Commands in, events out (0005) |
| **Client** | A UI on top of the engine: the TUI first, later maybe a web or desktop app (0009) |
| **Daemon** | The engine running detached, so work survives closing a client. One per user, for all offices (0005) |
| **Worker host** | A detached process per session that runs the worker and writes its output to a file, so a daemon restart never kills a session (0005) |
| **Agent** | An AI worker doing a job, created from a role |
| **Role** | A stored, versioned definition of a kind of agent inside an office: purpose, instructions, allowed tools, default model and effort (0001, M4) |
| **Hiring** | Adding a role to an office's roster |
| **Roster** | The roles available in one office |
| **Worker adapter** | The interface through which the engine runs an agent. The Claude Code CLI is the first adapter (0008) |
| **Box** | The Apple `container` VM a developer runs in, one per story, from claim to merge, with its own local git repository. The box is the isolation boundary (0008) |
| **Part** | A piece of work the worker hands over from its box. dipo scans it, commits it on the story branch and pushes it (0008) |
| **Test box** | A short-lived box that runs a story's pushed head for the maintainer's test (0002) |
| **Context provider** | The part of the engine that decides which code a worker sees, from the story's references and inputs (0014) |
| **Story** | A unit of work in Backlog.md with outcome, acceptance criteria, dependencies, references, test plan and status (0012) |
| **References** | The planner's forecast of the files a story will touch. Used for scheduling and context, not a write fence (0012) |
| **Milestone** | A group of stories in Backlog.md, used in place of epics (0003) |
| **Spike** | A story that ends in a decision record rather than product code (0012) |
| **Ready** | A story that passed the Ready gate: its unknowns are resolved and it meets the story standard. Only Ready stories run (0012) |
| **Unknown** | An open question about a story that must be resolved before it is Ready |
| **Tier** | A story's difficulty (S, M, L), set at refine time and confirmed by the maintainer. It chooses the model and caps (0008) |
| **Caps** | The limits of a run: tokens, turns, minutes, loops, review rounds, CI and conflict attempts. Fixed at run start; only a recorded grant raises one (0020) |
| **Park** | Stopping a story that needs a human, with one of eight reasons, while other work continues. Parked is the only waiting state; `dipo resume` brings it back (0001, 0020) |
| **Starts paused** | An office-level state for problems that are not a story's: a plan limit, or a broken CLI or box token. No new session starts until it lifts (0020) |
| **Fix round** | One round of feedback to the same worker in its box, for every source: report gate, conflict, review, CI, reject (0002) |
| **Reviewer** | A separate agent that checks each pushed head against the story goal, in a read-only box of its own. Never sees the developer's reasoning (0002) |
| **Gate** | A point where a rule or the maintainer must pass the work before it advances: the Ready gate, the review, the merge gate (0002, 0012) |
| **Merge gate** | The decision to merge a PR whose review approved. By rule, and then GitHub merges once the checks pass on the close-out head; or it waits for the maintainer, and then it opens only once the checks are green (0002) |
| **Acceptance test** | The maintainer testing the behaviour of a flagged story with `dipo test` (0002) |
| **State database** | The one local SQLite file with the run detail of every office, keyed by office, outside every repository (0007) |
| **Your desk** | Everything waiting on the maintainer, in one ordered list: starts paused, questions, merge gates, parked stories, hand actions, proposals (0020) |
| **Proposal** | A follow-up, spike or tool a worker suggests. Nothing happens until the maintainer accepts it (0020) |
| **Phase** | Step of a run: `setup`, `build`, `review`, `test`, `merge` (0009) |
| **Health** | The engine-derived state of a running session: `lost`, `looping`, `stuck`, `quiet`, `busy` (0009) |
| **Evidence label** | How a shown value is known: `checked` (engine measured it), `claimed` (worker, CLI or reviewer said so), `estimated` (computed by a rule), `none` (no fact) (0009) |
| **ADR** | Architecture decision record in `docs/decisions/`. Describes what runs; a changed decision rewrites the body (0003) |
