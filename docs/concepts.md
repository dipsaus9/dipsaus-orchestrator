# Concepts

Shared vocabulary. Terms marked **[proposed]** are not yet confirmed by the maintainer.

| Term | Meaning |
|---|---|
| **Office** | One project as seen in the orchestrator: its backlog, roster, running work and state. Offices are isolated from each other |
| **Project** | A development repository with Backlog.md in which an office is initialized |
| **Office list** | The software-level list of known offices that the maintainer switches between. Holds no work state |
| **Maintainer** | The human: visionary, manager, tester. Decides direction and approves gates |
| **Orchestrator** | The code-driven core, plus the AI-assisted helper that sets things up for the maintainer. Code first, AI to fill gaps |
| **Engine** | The headless part of the orchestrator: state, gates, scheduling, workers, git. Exposes commands in and events out |
| **Client** | A UI on top of the engine: the TUI first, later maybe a web or desktop app |
| **Daemon** | The engine running detached so work survives closing a client |
| **Agent** | An AI worker doing a job. Created from a role |
| **Role** | A stored, versioned definition of a kind of agent inside an office: purpose, instructions, allowed tools, default model and effort. Examples: developer, tester, reviewer, UX designer, visual designer |
| **Hiring** | Adding a role to an office's roster |
| **Roster** | The roles available in one office |
| **Worker adapter** | The interface through which the engine runs an agent. Claude Code CLI is the first adapter |
| **Context provider** | The part of the engine that decides which code and facts a worker sees. The default uses the story scope, inputs and the declared component map; codegraph is an optional backend (research section 7) |
| **Story** | A unit of work in Backlog.md with outcome, acceptance criteria, dependencies, scope and status |
| **Milestone** | A group of stories in Backlog.md. Used in place of epics |
| **Spike** | A story that ends in a decision record rather than product code |
| **Ready** | A story whose unknowns are resolved and which meets the story standard. Only Ready stories run |
| **Unknown** | An open question about a story that must be resolved before it is Ready |
| **Tier** | A story's difficulty (S, M, L to start), set at refine time and confirmed by the maintainer |
| **Effort** | The model, budget and loop cap a tier maps to, from office configuration |
| **Park** | Stopping a story that needs a human, with a structured reason, while other work continues |
| **Reviewer** | A separate agent that checks a PR against the story goal. Does not see the implementer's reasoning |
| **Acceptance test** | The maintainer testing behavior of a flagged story by running it |
| **Gate** | A point where a rule or the maintainer must pass the work before it advances |
| **State database** | Local store of orchestration state and machine insights: one central database outside every repository, keyed by office (0007) |
| **Triage list** | The morning view of parked stories with reasons and actions |
| **Your desk** [proposed] | Everything waiting on the maintainer: open questions, gates, flagged tests, parked stories. Contains the triage list; on-hold stories are listed apart as "Held by you" (0009) |
| **Evidence label** [proposed] | How a shown value is known: `checked` (engine measured it), `claimed` (worker, CLI or reviewer said so), `estimated` (computed by a rule), `none` (no fact) (0009) |
| **Health** [proposed] | Engine-derived state of a running agent from facts and timeouts: `lost`, `asking`, `limited`, `paused`, `looping`, `stuck`, `quiet`, `busy` (0009) |
| **Phase** [proposed] | Step of a run: `setup`, `build`, `verify`, `review`, `test`, `merge` (0009) |
| **Signal** [proposed] | A watchdog fact about a run: `no-output`, `same-failure`, `input-wait`, `plan-limit`, `host-lost`, `follow-only` (0009) |
| **ADR** | Architecture decision record in `docs/decisions/` |
