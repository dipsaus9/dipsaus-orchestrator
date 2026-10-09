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
| **Story** | A unit of work in Backlog.md with outcome, acceptance criteria, dependencies, scope and status |
| **Milestone** | A group of stories in Backlog.md. Used in place of epics |
| **Spike** | A story that ends in a decision record rather than product code |
| **Ready** | A story whose unknowns are resolved and which meets the story standard. Only Ready stories run |
| **Unknown** | An open question about a story that must be resolved before it is Ready |
| **Effort** **[proposed]** | The model and token budget assigned to a job, chosen by its difficulty |
| **Park** | Stopping a story that needs a human, with a structured reason, while other work continues |
| **Reviewer** | A separate agent that checks a PR against the story goal. Does not see the implementer's reasoning |
| **Acceptance test** | The maintainer testing behavior of a flagged story by running it |
| **Gate** | A point where a rule or the maintainer must pass the work before it advances |
| **State database** | Local, gitignored, per-project store of orchestration state and machine insights |
| **Triage list** | The morning view of parked stories with reasons and actions |
| **ADR** | Architecture decision record in `docs/decisions/` |
